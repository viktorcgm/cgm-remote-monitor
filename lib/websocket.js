'use strict';

var levels = require('./levels');
var times = require('./times');
var calcData = require('./data/calcdelta');
var ObjectID = require('mongodb').ObjectID;
       
function init (env, ctx, server) {

  function websocket ( ) {
    return websocket;
  }

  //var log_yellow = '\x1B[33m';
  var log_green = '\x1B[32m';
  var log_reset = '\x1B[0m';
  var LOG_WS = log_green + 'WS: ' + log_reset;
  
  var io;
  var watchers = 0;
  var lastData = {};

  // TODO: this would be better to have somehow integrated/improved
  var supportedCollections = { 
  'treatments' : env.treatments_collection, 
  'entries': env.mongo_collection, 
  'devicestatus': env.devicestatus_collection, 
  'profile': env.profile_collection, 
  'food': env.food_collection
  };

  var alarmType2Level = {
    urgent_alarm: levels.URGENT
    , alarm: levels.WARN
  };

  function start ( ) {
    io = require('socket.io')({
      'transports': ['xhr-polling'], 'log level': 0
    }).listen(server, {
      //these only effect the socket.io.js file that is sent to the client, but better than nothing
      'browser client minification': true,
      'browser client etag': true,
      'browser client gzip': false
    });
  }
  
  function verifyAuthorization(secret) {
    var read, write, write_treatment;
    
    // read now true by default
    read = true;
    write = (secret === env.api_secret);
    write_treatment = !env.treatments_auth || (secret === env.api_secret);
    
    return {
      read: read
      , write: write
      , write_treatment: write_treatment
    };
  }

  function emitData (delta) {
    if (lastData.cals) {
      console.log(LOG_WS + 'running websocket.emitData', ctx.ddata.lastUpdated);
      io.to('DataReceivers').emit('dataUpdate', delta);
    }
  }

  function listeners ( ) {
    io.sockets.on('connection', function (socket) {
      var socketAuthorization = null;
      var clientType = null;
      var timeDiff;
      var history;

      var remoteIP = socket.request.headers['x-forwarded-for'] || socket.request.connection.remoteAddress;
      console.log(LOG_WS + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      io.emit('clients', ++watchers);
      socket.on('ack', function(alarmType, silenceTime) {
        //TODO: Announcement hack a1/a2
        var level = alarmType2Level[alarmType] || alarmType;
        ctx.notifications.ack(level, silenceTime, true);
      });

      socket.on('disconnect', function () {
        io.emit('clients', --watchers);
        console.log(LOG_WS + 'Disconnected client ID: ',socket.client.id);
      });

      
      function checkConditions(action, data) {
        var collection = supportedCollections[data.collection];
        if (!collection) {
          console.log('WS dbUpdate/dbAdd call: ', 'Wrong collection', data);
          return { result: 'Wrong collection' };
        }

        if (!socketAuthorization) {
          console.log('WS dbUpdate/dbAdd call: ', 'Not authorized', data);
          return { result: 'Not authorized' };
        }

        if (data.collection === 'treatments') {
          if (!socketAuthorization.write_treatment) {
            console.log('WS dbUpdate/dbAdd call: ', 'Not permitted', data);
            return { result: 'Not permitted' };
          }
        } else {
          if (!socketAuthorization.write) {
            console.log('WS dbUpdate call: ', 'Not permitted', data);
            return { result: 'Not permitted' };
          }
        }
        
        if (action === 'dbUpdate' && !data._id) {
          console.log('WS dbUpdate/dbAddnot sure abou documentati call: ', 'Missing _id', data);
          return { result: 'Missing _id' };
        }

        return null;
      }

      // dbUpdate message  
      //  {
      //    collection: treatments
      //    _id: 'some mongo record id'
      //    data: {
      //      field_1: new_value,
      //      field_2: another_value
      //    }
      //  }
      socket.on('dbUpdate', function dbUpdate(data, callback) {
       console.log(LOG_WS + 'dbUpdate client ID: ', socket.client.id, ' data: ', data);
       var collection = supportedCollections[data.collection];
        
        var check = checkConditions('dbUpdate', data);
        if (check) {
         if (callback) {
            callback( check );
          }
          return;
        }
        
        ctx.store.db.collection(collection).update(
          { '_id': new ObjectID(data._id) },
          { $set: data.data }
        );
          
        if (callback) {
          callback( { result: 'success' } );
        }
        ctx.bus.emit('data-received');
      });
      
      // dbAdd message  
      //  {
      //    collection: treatments
      //    data: {
      //      field_1: new_value,
      //      field_2: another_value
      //    }
      //  }
      socket.on('dbAdd', function dbAdd(data, callback) {
       console.log(LOG_WS + 'dbAdd client ID: ', socket.client.id, ' data: ', data);
        var collection = supportedCollections[data.collection];
        
        var check = checkConditions('dbAdd', data);
        if (check) {
         if (callback) {
            callback( check );
          }
          return;
        }
        
        if (data.collection === 'treatments' && !('eventType' in data.data)) {
          data.data.eventType = '<none>';
        }
        if (!('created_at' in data.data)) {
          data.data.created_at = new Date().toISOString();
        }
        
        ctx.store.db.collection(collection).insert(data.data, function insertResult(err, doc) {
          if (callback) {
            callback(doc.ops);
          }
          ctx.bus.emit('data-received');
        });
          
      });
      
      // Authorization message
      // {
      //  client: 'web' | 'phone' | 'pump'  
      //  , secret: 'secret_hash'
      // }
      socket.on('authorize', function authorize(message, callback) {
        socketAuthorization = verifyAuthorization(message.secret);
        clientType = message.client;
        history = message.history || 48; //default history is 48 hours
        
        if (socketAuthorization.read) {
          socket.join('DataReceivers');
          // send all data upon new connection
          if (lastData && lastData.split) {
            var split = lastData.split(Date.now(), times.hours(3).msecs, times.hours(history).msecs);
            //send out first chunk
            socket.emit('dataUpdate', split.first);

            //then send out the rest
            setTimeout(function sendTheRest() {
              split.rest.delta = true;
              socket.emit('dataUpdate', split.rest);
            }, 500);
          }
        }
        console.log(LOG_WS + 'Authetication ID: ',socket.client.id, ' client: ', clientType, ' history: ' + history);
        if (callback) {
          callback(socketAuthorization);
        }
      });
      
      // Pind message
      // {
      //  mills: <local_time_in_milliseconds>  
      // }
      socket.on('ping', function ping (message, callback) {
        var clientTime = message.mills;
        timeDiff = new Date().getTime() - clientTime;
        console.log(LOG_WS + 'Ping from client ID: ',socket.client.id, ' client: ', clientType, ' timeDiff: ', (timeDiff/1000).toFixed(1) + 'sec');
        if (callback) {
          callback({ result: 'pong', mills: new Date().getTime() });
        }
      });
    });
  }

  websocket.update = function update ( ) {
    console.log(LOG_WS + 'running websocket.update');
    if (lastData.sgvs) {
      var delta = calcData(lastData, ctx.ddata);
      if (delta.delta) {
        console.log('lastData full size', JSON.stringify(lastData).length,'bytes');
        if (delta.sgvs) { console.log('patientData update size', JSON.stringify(delta).length,'bytes'); }
        emitData(delta);
      } else { console.log('delta calculation indicates no new data is present'); }
    }
    lastData = ctx.ddata.clone();
  };

  websocket.emitNotification = function emitNotification (notify) {
    if (notify.clear) {
      io.emit('clear_alarm', true);
      console.info(LOG_WS + 'emitted clear_alarm to all clients');
    } else if (notify.level === levels.WARN) {
      io.emit('alarm', notify);
      console.info(LOG_WS + 'emitted alarm to all clients');
    } else if (notify.level === levels.URGENT) {
      io.emit('urgent_alarm', notify);
      console.info(LOG_WS + 'emitted urgent_alarm to all clients');
    } else if (notify.isAnnouncement) {
      io.emit('announcement', notify);
      console.info(LOG_WS + 'emitted announcement to all clients');
    }
  };
  
  start( );
  listeners( );

  return websocket();
}

module.exports = init;
