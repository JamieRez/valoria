require('dotenv').config(); 
const express = require('express');
const app = express();
const server = require('http').Server(app);
const port = process.env.PORT || '8000';

const Valoria = require('./valoria');
const valoria = new Valoria(server, app);
// valoria.test();

app.use(express.static('client'));
app.set('views', 'client')
app.set('view engine', 'pug');

app.get('/', async(req, res) => {
  res.render('index');
})

server.listen(port, () => {
  console.log("Valoria Server started on PORT: " + port);
})
