
'use strict';

// Modules
var fs             = require('fs');
var http           = require('http');
var https          = require('https');
var express        = require('express');
var methodOverride = require('method-override');
var compression    = require('compression');
var serve_static   = require('serve-static');
var bodyParser     = require('body-parser');

// Settings
var config_ip            = process.env.OPENSHIFT_NODEJS_IP   || '127.0.0.1'; // IP or Hostname
var config_port          = process.env.OPENSHIFT_NODEJS_PORT || 3000;
var config_ssl_enabled   = false;
var config_redirect_on   = false;
var config_redirect_port = 80;

// This is for HTTP redirecting to HTTPS
if (config_redirect_on === true) {
  var http_redirect = express();
  http_redirect.get('*', function (req, res) {
    res.redirect('https://' + config_ip);
  }).listen(config_redirect_port);
}

// Express App
var app = express();
app.set('port', config_port);
app.set('ipaddr', config_ip);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended : false }));
app.use(methodOverride());
app.use(compression());
app.use(serve_static(__dirname + '/public'));
app.use('/components', serve_static(__dirname + '/components'));

app.get('/', function (req, res) {
  res.render('index.html');
});

// Create HTTP or HTTPS Server
var server;
if (config_ssl_enabled === true) {
  // HTTPS Server
  var file_privateKey  = fs.readFileSync('ssl/server.key').toString();
  var file_certificate = fs.readFileSync('ssl/freestep_net.crt').toString();
  var file_ca          = fs.readFileSync('ssl/COMODO.ca-bundle').toString();
  server = https.createServer({
    key  : file_privateKey,
    cert : file_certificate,
    ca   : file_ca
  }, app);
} else {
  // HTTP Server
  server = http.createServer(app);
}
server.listen(app.get('port'), app.get('ipaddr'), function () {
  console.log('Express server listening on', app.get('ipaddr') + ':' + app.get('port'));
});

// #####################
// ##### Socket.io #####
// #####################
var io = require('socket.io').listen(server);

// lets us get room memebers in socket.io >=1.0
function findClientsSocketByRoomId (roomId, callback) {
  // Old Way
  // var room = io.sockets.adapter.rooms[roomId];
  // if(room) {
  //    for(var id in room) {
  //       res.push(io.sockets.adapter.nsp.connected[id]);
  //    }
  // }
  // return res;
  var res = [];
  io.of('/').in(roomId).clients(function (error, clients) {
    if (error) { return callback(error); }
    clients.forEach(function (client) {
      res.push(client);
    });
    callback(undefined, res);
  });
}

// Handles Socket Data Storage in Memory
// Looking for persistent/Redis support? See below
// https://github.com/socialtables/socket.io-store
//
// Example Data
// socket_data = {
//   '9evVFCugeYJWs6wFAAAA' : {
//     'nickname' : 'bob',
//     'roomIn'   : 'main'
//   }
//   '9evVFCugeYJWs6wFAAAA' : {
//     'nickname' : 'bob',
//     'roomIn'   : 'main'
//   }
// };
var socket_data = {};
io.use(function (socket, next) {
  // Initialize
  socket_data[socket.id] = {};
  socket.get = function (key) {
    return socket_data[socket.id][key];
  };
  socket.set = function (key, value) {
    socket_data[socket.id][key] = value;
  };
  next();
});

io.sockets.on('connection', function (socket) {

  var lastImageSend = 0;
  var isRateLimited = true;

  // emits newuser
  socket.on('joinReq', function (name, room, password) {

    var roomID       = room + password;
    //var roomPassword = password; // Unused
    var allowJoin    = true;
    var denyReason   = null;

    //get the client list and push it to the client
    findClientsSocketByRoomId(roomID, function (error, clientsInRoom) {
      if (error) { throw error; }

      var clientsInRoomArray         = [];
      var clientsInRoomArrayScrubbed = [];
      clientsInRoom.forEach(function (client) {
        var handle = io.sockets.sockets[client];
        clientsInRoomArray.push(handle.get('nickname'));
        // the scrubbed one has the sanitized version as used in the username
        // classes for typing, so we can check and avoid collisions.
        clientsInRoomArrayScrubbed.push(handle.get('nickname').replace(/\W/g, ''));
      });

      // check if the nickname exists
      if (clientsInRoomArrayScrubbed.indexOf(name.replace(/\W/g, '')) !== -1) {
        allowJoin  = false;
        denyReason = 'Nickname is already taken.';
      }

      if (allowJoin === true) {
        // now in the room
        socket.join(roomID);
        socket.set('nickname', name);
        socket.set('roomIn', roomID);

        //send the join confirmation to the client, alert the room, and push a user list
        socket.emit('joinConfirm');

        //add them to the user list since they're now a member
        clientsInRoomArray.push(socket.get('nickname'));
        io.sockets.in(roomID).emit('newUser', name);
        socket.emit('userList', clientsInRoomArray);
      } else {
        socket.emit('joinFail', denyReason);
      }

    });

  });

  // emits goneuser
  socket.on('disconnect', function () {
    io.sockets.in(socket.get('roomIn')).emit('goneUser', socket.get('nickname'));
    delete socket_data[socket.id];
  });

  // emits typing
  socket.on('typing', function (typing) {
    io.sockets.in(socket.get('roomIn')).emit('typing', [typing, socket.get('nickname')]);
  });

  // emits chat
  socket.on('textSend', function (msg) {
    // 0 = text
    var type = 0;
    var name = socket.get('nickname');
    var data = [type, name, msg];
    io.sockets.in(socket.get('roomIn')).emit('chat', data);
  });

  // lets admins un-ratelimit themselves for data
  socket.on('unRateLimit', function () {
    isRateLimited = false;
  });

  // emits data
  socket.on('dataSend', function (msg) {
    var currTime = Date.now();
    if(((currTime - lastImageSend) < 5000) && isRateLimited) {
      // it's been less than five seconds; no data for you!
      socket.emit('rateLimit');
    } else {
      lastImageSend = currTime;
      // 1 = image
      var type = 1;
      var name = socket.get('nickname');
      var data = [type, name, msg];
      io.sockets.in(socket.get('roomIn')).emit('chat', data);
    }
  });

});
