const http = require('http');
const express = require('express');
const App = express();
const crypto = require('crypto');
const subtle = crypto.webcrypto.subtle; 
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const request = require('request');
const herokuKey = process.env.HEROKU_API_KEY;
const {Storage} = require('@google-cloud/storage');
const storage = new Storage();
const isLocal = process.env.PORT ? false : true;
const port = process.env.PORT || '8000';
const ioclient = require("socket.io-client");
const initialServers = require('./servers.json');

const disabledPaths = {
  [__dirname + "/app"]: true,
  // [__dirname + "/node_modules"]: true,
  // [__dirname + ".git"]: true,
}

const maxDecimal = 115792089237316195423570985008687907853269984665640564039457584007913129639935;

var copyRecursiveSync = function(src, dest) {
  if(src == ".env") return;
  var exists = fs.existsSync(src);
  var stats = exists && fs.statSync(src);
  var isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if(disabledPaths[src] || fs.existsSync(dest)) return
    fs.mkdirSync(dest);
    fs.readdirSync(src).forEach(function(childItemName) {
      copyRecursiveSync(path.join(src, childItemName),
                        path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
};

module.exports = class Valoria {
  constructor (server, app, io) {
    this.url = "";
    this.app = app || App;
    this.server = {};
    const thisVal = this;
    this.app.enable('trust proxy');
    this.app.use(async(req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
      if(!thisVal.url){
        const url = req.protocol + '://' + req.get('host') + "/";
        if(url.startsWith('http://localhost')) {
          next();
          return;
        }
        thisVal.url = url;
        thisVal.server.url = thisVal.url;
        await thisVal.saveFileData('server.json', thisVal.server);
        await thisVal.loadAllServers();
        await thisVal.joinServerNetwork();
      }
      next();
    });
    this.io = require('socket.io')(server, {
      cors: {
        origin: "*"
      }
    });
    this.ECDSAPair = {
      publicKey: '',
      privateKey: ''
    }
    this.ownerId = process.env.VALORIA_USER_ID;
    this.online = {};
    this.authenticating = {};
    this.range = []
    this.above = {}
    this.below = {};
    this.servers = {};
    this.serverConns = {};
    this.promises = {};
    this.setup();
  }

  async setup(){

    const thisVal = this;
    if(process.env.GOOGLE_APPLICATION_CREDENTIALS){
      await thisVal.setupCloudStorage();
    }
    try {
      await thisVal.loadServerCredentials();
    } catch (e){
      await thisVal.generateServerCredentials();
    }
    thisVal.app.get('/data/:path', async(req, res) => {
      if(req.params.path.length < 1) return;
      const data = await thisVal.getFileData(req.params.path)
      res.send(data);
    })
    // if(thisVal.server.url) {
    //   axios.get(thisVal.server.url + "data/server.json"); //Validates server url
    // }
    thisVal.io.on("connection", (socket) => {
      thisVal.setupSocket(socket);
    })
  }

  async getFileData(path){
    const thisVal = this;
    return new Promise( async(res, rej) => {
      try{
        if(thisVal.bucket){
          let buf = ''
          thisVal.bucket.file(path)
            .createReadStream()
            .on('data', d => (buf += d))
            .on('end', () => res(JSON.parse(buf)))
            .on('error', e => rej(e))
        } else {
          const data = await fs.readFileSync(__dirname + "/data/" + path, "utf-8");
          res(JSON.parse(data));
        }
      } catch(e){
        rej(e);
      }
    })
  }

  async saveFileData(path, data){
    const thisVal = this;
    return new Promise( async(res, rej) => {
      if(typeof data == "object"){
        data = JSON.stringify(data, null, 2);
      }
      try{
        if(thisVal.bucket){
          await thisVal.bucket.file(path).save(data);
        } else {
          fs.mkdirSync(__dirname + "/data/");
          await fs.writeFileSync(__dirname + "/data/" + path, data);
        }
        res();
      } catch(e){
        rej(e);
      }
    })
  }

  async joinServerNetwork(){
    if(isLocal) return;
    const thisVal = this;
    return new Promise(async(res, rej) => {
      if(Object.keys(thisVal.above).length == 0 && Object.keys(thisVal.below).length == 0){
        let servers = {};
        Object.assign(servers, thisVal.servers);
        delete servers[thisVal.url];
        const keys = Object.keys(servers);
        if(keys.length > 0){
          const rand = keys[keys.length * Math.random() << 0];
          await thisVal.neighborWithServer(rand);
          console.log("FINISHED NEIGHBORING WITH THE SERVER!");
        }
      }
    })
  }

  async neighborWithServer(url){
    const thisVal = this;
    return new Promise(async(res, rej) => {
      const socket = ioclient(url);
      thisVal.setupSocket(socket);
      thisVal.serverConns[url] = socket;
      socket.serverUrl = url;
      socket.emit("Initiate neighbor connection", {url: thisVal.url});
      thisVal.promises["Neighbor Connection with " + url] = {res, rej}
    })
  }

  async setupSocket(socket){
    const thisVal = this;

    socket.on("Load all servers", async () => {
      const servers = await this.getFileData("servers.json");
      socket.emit("Load all servers", servers);
    })

    socket.on("Initiate neighbor connection", async (d) => {
      if(!d.url) return;
      try {
        await thisVal.verifyServer(socket, d.url);
        const neighborWillBeAbove = Math.floor(Math.random() * 2) 
        let thirdNeighbor;
        let neighborRange;
        let rangeSize = 0;
        if(neighborWillBeAbove){
          thirdNeighbor = thisVal.above[0];
          rangeSize = (thirdNeighbor.range[1] - thisVal.range[0]) / 2;
          thisVal.range = [thisVal.range[0], thisVal.range[0] + rangeSize];
          neighborRange = [thisVal.range[1], thisVal.range[1] + rangeSize];
          if(!thirdNeighbor && thisVal.below[0] && thisVal.range[1] == maxDecimal){
            thirdNeighbor = thisVal.below[0];
          }
        } else {
          thirdNeighbor = thisVal.below[0];
          if(!thirdNeighbor && thisVal.above[0] && thisVal.range[0] == 0){
            thirdNeighbor = thisVal.above[0];
          }
        }
        socket.emit("Neighbor connected");
      } catch (e){

      }
    });

    socket.on("Neighbor connected", () => {
      thisVal.promises["Neighbor Connection with " + socket.serverUrl].res();
    })

    socket.on("Sign verification token", async (token) => {
      if(!thisVal.serverConns[socket.serverUrl]) return;
      const sig = await thisVal.sign(token);
      socket.emit("Verify signature", sig);
    })

    socket.on("disconnect", () => {
      if(thisVal.online[socket.vId]) delete thisVal.online[socket.vId];
      if(thisVal.authenticating[socket.vId]) delete thisVal.authenticating[socket.vId];
    })

  }

  async loadAllServers(){
    if(isLocal) return;
    const thisVal = this;
    return new Promise(async(res, rej) => {
      try{
        let myServers = await thisVal.getFileData("servers.json");
        Object.assign(myServers, initialServers);
        delete myServers[thisVal.url];
        const keys = Object.keys(myServers);
        if(keys.length == 0) throw "No Servers Found"
        const rand = keys[keys.length * Math.random() << 0];
        const socket = ioclient(rand);
        socket.emit("Load all servers");
        socket.on("Load all servers", async (servers) => {
          socket.off("Load all servers");
          socket.disconnect();
          thisVal.servers = {...servers, ...myServers};
          await thisVal.saveFileData("servers.json", thisVal.servers);
          res();
        })
      }catch(e){
        //1st server
        thisVal.range = [0, maxDecimal]
        thisVal.servers = {
          [thisVal.url]: thisVal.range
        };
        await thisVal.saveFileData("servers.json", thisVal.servers);
        res();
      }
    })
  }

  async verifyServer(socket, url){
    const thisVal = this;
    return new Promise(async(res, rej) => {
      const verifToken = await crypto.randomBytes(256);
      const serverData = (await axios.get(url + "data/server.json")).data;
      const pubKey = await subtle.importKey(
        'jwk',
        serverData.pubEcdsa,
        {
          name: 'ECDSA',
          namedCurve: 'P-384'
        },
        true,
        ['verify']
      )
      socket.emit("Sign verification token", verifToken)
      socket.on("Verify signature", async (sig) => {
        const isValid = await subtle.verify(
          {
            name: "ECDSA",
            hash: "SHA-384",
          },
          pubKey,
          sig,
          verifToken
        )
        if(isValid) {
          console.log("VERIFIED " + url);
          thisVal.serverConns[url] = socket;
          res()
        } else {
          console.log("BAD SIGNATURE");
          rej();
        }
      })
    })
  }

  async loadServerCredentials(){
    const thisVal = this;
    return new Promise(async (res, rej) => {
      try {
        const server = await thisVal.getFileData("server.json");
        thisVal.server = server;
        const pubEcdsaJwk = server.pubEcdsa;
        const prvEcdsaJwk = server.prvEcdsa;
        thisVal.range = server.range || [];
        thisVal.above = server.above || {};
        thisVal.below = server.below || {};
        const pubEcdsaKey = await subtle.importKey(
          'jwk',
          pubEcdsaJwk,
          {
            name: 'ECDSA',
            namedCurve: 'P-384'
          },
          true,
          ['verify']
        )
        const salt = new Uint8Array(prvEcdsaJwk.salt.data);
        const keyMaterial = await subtle.importKey(
          "raw",
          new TextEncoder().encode(process.env.VALORIA_SERVER_SECRET),
          {name: "PBKDF2"},
          false,
          ["deriveBits", "deriveKey"]
        );
        const iv = new Uint8Array(prvEcdsaJwk.iv.data);
        try {
          const unwrappingKey = await subtle.deriveKey(
            {
              "name": "PBKDF2",
              salt: salt,
              "iterations": 100000,
              "hash": "SHA-256"
            },
            keyMaterial,
            { "name": "AES-GCM", "length": 256},
            true,
            [ "wrapKey", "unwrapKey" ]
          );
          const prvEcdsaKey = await subtle.unwrapKey(
            "jwk",
            Buffer.from(prvEcdsaJwk.wrapped, 'base64'),
            unwrappingKey,
            {
              name: "AES-GCM",
              iv: iv
            },
            {                      
              name: "ECDSA",
              namedCurve: "P-384"
            },  
            true,
            ["sign"]
          )
          thisVal.ECDSAPair.publicKey = pubEcdsaKey;
          thisVal.ECDSAPair.privateKey = prvEcdsaKey;
          res();
        } catch(e){
          rej(e);
        }
      } catch(e){
        rej(e)
      }
    })
  }

  async generateServerCredentials(){
    const thisVal = this;
    return new Promise(async (res, rej) => {
      try {
        const ecdsaPair = await subtle.generateKey(
          {
            name: 'ECDSA',
            namedCurve: 'P-384'
          },
          true,
          ['sign', 'verify']
        );
        thisVal.ECDSAPair.publicKey = ecdsaPair.publicKey;
        thisVal.ECDSAPair.privateKey = ecdsaPair.privateKey;
        const pubKeyJwk = await subtle.exportKey('jwk', ecdsaPair.publicKey)
        const salt = crypto.randomBytes(16);
        const keyMaterial = await subtle.importKey(
          "raw",
          new TextEncoder().encode(process.env.VALORIA_SERVER_SECRET),
          {name: "PBKDF2"},
          false,
          ["deriveBits", "deriveKey"]
        );
        const iv = crypto.randomBytes(12);
        const wrappingKey = await subtle.deriveKey(
          {
            "name": "PBKDF2",
            salt: salt,
            "iterations": 100000,
            "hash": "SHA-256"
          },
          keyMaterial,
          { "name": "AES-GCM", "length": 256},
          true,
          [ "wrapKey", "unwrapKey" ]
        );
        const wrappedKey = await subtle.wrapKey(
          "jwk",
          ecdsaPair.privateKey,
          wrappingKey,
          {
            name: "AES-GCM",
            iv: iv
          }
        );
        const wrapped = Buffer.from(wrappedKey).toString('base64');
        const prvKeyJwk = {wrapped : wrapped, salt: salt, iv: iv};
        this.server = {
          pubEcdsa: pubKeyJwk,
          prvEcdsa: prvKeyJwk
        }
        try {
          await thisVal.saveFileData('server.json', {
            pubEcdsa: pubKeyJwk,
            prvEcdsa: prvKeyJwk
          });
          res();
        } catch (e){
          rej(e)
        }
      } catch(e){
        rej(e);
      }
    })
  }

  async setupCloudStorage(){
    const thisVal = this;
    return new Promise(async (res, rej) => {
      thisVal.bucket = storage.bucket(process.env.BUCKET_NAME || "Valoria");
      try {
        const [metadata] = await thisVal.bucket.getMetadata();
      } catch (error) {
        if(error.code == 404){
          try {
            const bRes = await storage.createBucket(thisVal.bucket.name);
          } catch (e){
          }
        }
      } 
      thisVal.storageUrl = "https://storage.googleapis.com/" + thisVal.bucket.name + "/";
      try {
        await thisVal.bucket.makePublic();
        await thisVal.bucket.setCorsConfiguration([
          {
            maxAgeSeconds: 3600,
            method: ["GET", "POST", "HEAD", "PUT", "DELETE"],
            origin: ["*"],
            responseHeader: [
              "Access-Control-Allow-Origin",
              "Content-Type",
              "x-goog-resumable",
              "Cache-Control"
            ],
          },
        ]);
        const [metadata] = await thisVal.bucket.getMetadata();
      } catch(e){
      }
      res();
    });
  }

  async sign (buffer) {
    const thisVal = this;
    return new Promise(async (resolve) => {
      const sig = await subtle.sign(
        {
          name: 'ECDSA',
          hash: 'SHA-384'
        },
       thisVal.ECDSAPair.privateKey,
        buffer,
      )
      resolve(sig);
    });
  }
  
  async verify (sigBuf, msgBuf, pubKey) {
    const thisVal = this;
    return new Promise(async (resolve) => {
      const isValid = await subtle.verify(
        {
          name: 'ECDSA',
          hash: 'SHA-384'
        },
        pubKey,
        sigBuf,
        msgBuf
      )
      resolve(isValid);
    });
  }

  async test(){
    return new Promise( async(res, rej) => {
      try{
        await fs.writeFileSync(__dirname + "/client/index.pug", `.valoria WELCOME to Valoria!`);
        if(herokuKey){
          copyRecursiveSync(__dirname + "/", __dirname + "/app");
          tar.c( // or tar.create
            {
              gzip: true
            },
            ['./app/']
          ).pipe(fs.createWriteStream(__dirname + '/slug.tgz'))
          const hData = (await axios.post(`https://api.heroku.com/apps/${process.env.HEROKU_APP_NAME}/slugs`,
            {
              process_types: {"web": "node index.js"}
            }, 
            {
              headers: {
                "Content-Type": "application/json",
                "Accept" : "application/vnd.heroku+json; version=3",
                "Authorization": "Bearer " + herokuKey
              }
            }
          )).data
          console.log("UPLOADING SLUG");
          request({
            url  : hData.blob.url,
            body : fs.readFileSync(__dirname + "/slug.tgz"),
            method: "PUT"
          }, async (err, message, data) => {
            if (err) return console.error(err);
            console.log("UPLOADED SLUG");
            await axios.post(`https://api.heroku.com/apps/${process.env.HEROKU_APP_NAME}/releases`, {"slug": hData.id}, {
              headers: {
                "Content-Type": "application/json",
                "Accept" : "application/vnd.heroku+json; version=3",
                "Authorization": "Bearer " + herokuKey
              }
            })
            console.log("SLUG RELEASED!");
          });
        }
        res();
      } catch(e){
        rej(e);
      }
    })
  }

}

