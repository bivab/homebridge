var Service = require("HAP-NodeJS").Service;
var Characteristic = require("HAP-NodeJS").Characteristic;
var request = require('request');
var net = require('net')
/* TODO:
 * - wait for success after command and then send the next
 * - support more devices
 */

var DEBUG = true;



PilightDeviceTypes = {
  RAW: 0,
  SWITCH: 1,
  DIMMER: 2,
  WEATHER: 3,
  RELAY: 4,
  SCREEN: 5,
  CONTACT: 6,
  PENDINGSW: 7,
  DATETIME: 8,
  XBMC: 9,
  LIRC: 10,
  WEBCAM: 11
}

function PilightPlatform(log, config){
  this.name = config['name']
  this.host = config['host']
  this.port = config['port']
  this.protocol = config['protocol']
  this.http_port = config['http-port']

  this.log = log;
}


function PilightClient(log, platform) {
    var that = this;

    this.log = log;
    this.platform = platform;
    this.registry = [];
    this.queue = [];

    this.connect();
    this.startHeartBeat();
    this.startSending();
}

PilightClient.prototype = {
  send: function(cmd, callback) {
    var msg = JSON.stringify(cmd);
    this.log("[PilightClient.send] "+msg);
    this.queue.push([msg, callback]);
  },
  

  startSending: function() {
    var that = this;
    var cb = function() {
      var msg = that.queue.shift();
      if (msg === undefined || msg[0] == undefined) {
        return;
      }
      that.log(that.queue);
      that.log("[PilightClient.send] "+msg[0]);
      that.socket.write(msg[0], msg[1]);
    };
    setInterval(cb, 500);
  },

  register: function(idx, accessory) {
    this.registry[idx] = accessory;
  },

  updateDevices: function(devices, values) {
    for(var device of devices) {
      var dev = this.registry[device]
      if(dev === undefined || dev.length === 0) {
        continue
      }
      this.log("[PilightClient.updateDevices] External update on device "
               + device);
      dev.update(values);
    }
  },

  startHeartBeat: function() {
    var that = this;
    var cb = function() { that.socket.write("HEART\n", "utf-8"); };
    this.heartBeatInterval = setInterval(cb, 60000);
  },

  onBeat: function() { 
    if(DEBUG) {
      var stamp =  new Date(Date.now());
      this.log("BEAT " + stamp);
    }

    if(this.heartBeatTimeout) {
      clearTimeout(this.heartBeatTimeout);
    }

    var that = this;
    var reconnectDelay = 150000;
    var reconnect = function() {
      that.log('[PilightClient.reconnect] Trying reconnect');
      try{
        that.socket.end();
        that.socket.destroy();
      }
      finally {
        that.connect();
      }
    }
    this.heartBeatTimeout = setTimeout(reconnect, reconnectDelay);
  },


  connect: function() {
    var that = this;
    var bootstrap = function() {
      that.log('connected to server!');
      var cmd = {
        "action": "identify",
        "options": {
          "config": 1
        }
      };
      that.send(cmd);
    }

    this.socket = net.connect({host:this.platform.host, port:this.platform.port}, bootstrap);

    this.socket.on('data', function(data) {
      data = data.toString();
      for(msg of data.split('\n')) {
        if(msg.length === 0) { continue; }

        if(msg === "BEAT") {
          that.onBeat();
          continue;
        }

        try {
          data = JSON.parse(data);
        } catch(e) {
          if (e instanceof SyntaxError) { that.log("SyntaxError in " + msg); }
          else { that.log("Error " + JSON.stringify(e)); }
          continue;
        }
        if(data['origin'] !== 'update') {
          continue;
        }
        that.updateDevices(data['devices'], data['values']);
      }
    });

    this.socket.on('end', function() {
      clearTimeout(that.heartBeatTimeout);
      clearTimeout(that.heartBeatInterval);
      that.log('disconnected from server');
    });
  }
}

PilightPlatform.prototype = {
  accessories: function(callback) {
    // XXX request config over socket crashes pilight
    var url = this.protocol + '://' + this.host + ':'
                + this.http_port +'/config';

    this.log("[PilightPlatform.accessories] Fetching pilight devices.");
    this.log("[PilightPlatform.accessories] Fetching from: "+url);

    var collected = [];
    var that = this;
    var client = new PilightClient(this.log, this);

    request.get({url: url, json:true}, function(err, response, json) {
      var accessory = null;

      if (!err && response.statusCode == 200) {

        for (var device_name in json['gui']) {

          var gui = json['gui'][device_name]
          var device = json['devices'][device_name]
          var accessory;

          for (var proto of device['protocol']) {

            that.log("[PilightPlatform.accessories] " + gui['name'] + " : " + proto);

            switch(proto) {
              case "brennenstuhl":
              case "elro_800_switch":
                accessory = PilightSwitch;
                break;
              case 'openweathermap':
                accessory = PilightTemperatureSensor;
                break;
              default: // arping, sunriseset, datetime, generic_label
                that.log("Unsupported pilight device (" + gui['name']
                         + ") with protocol " + device['protocol']);
                continue;
            }
            that.log("Adding pilight device (" + gui['name'] + ") with protocol "
                     + device['protocol']);
            collected.push(
                    new accessory(that.log, device_name, gui['name'], proto, device, client));
            break;  // we found a supported protocol, so we are done with this device
          }
        }
        callback(collected);
      } else {
        that.log("There was a problem requesting the configuration from pilight.");
      }
    });
  }
}

function PilightSwitch(log, idx, name, protocol, info, client) {
  // device info
  log("Name: "+idx);
  this.idx = idx;
  this.name = name;
  this.log = log;
  this.client = client;
  this.protocol = protocol;

  this.powerState = info['state'] === 'on';
  this.registerForUpdates(this.idx, this);
}


PilightSwitch.prototype = {

  registerForUpdates: function(characteristic) {
    this.log("[PilightSwitch.registerForUpdates] Registering device "+this.idx
             + " for updates");
    this.client.register(this.idx, this);
  },

  update: function(values) {
    this.powerState = values['state'] === 'on';
  },

  setPowerState: function(powerOn, callback) {
    this.log("[PilightSwitch.setPowerState] "+powerOn);
    var cb = function() {
      callback();
      this.powerState = powerOn;
    }.bind(this);
    var cmd = {
          "action": "control",
          "code": {
            "device": this.idx,
            "state": (powerOn)?"on":"off"
          }};
    this.client.send(cmd, cb);
  },

  getPowerState: function(callback){
    this.log("[PilightSwitch.getPowerState] Fetching power state for: " + this.name);
    callback(null, this.powerState);
  },

  getServices: function() {
    var outletService = new Service.Outlet();
    var informationService = new Service.AccessoryInformation();
    var model;

    informationService
      .setCharacteristic(Characteristic.Manufacturer, "pilight")
      .setCharacteristic(Characteristic.Model, "Outlet Rev-2")
      .setCharacteristic(Characteristic.SerialNumber, "BIVAB-PO-1");

    outletService.getCharacteristic(Characteristic.On)
            .on('get', this.getPowerState.bind(this))
            .on('set', this.setPowerState.bind(this));
    return [informationService, outletService];
  }
};

// XXX refactory and merge with Switch
function PilightTemperatureSensor(log, idx, name, protocol, info, client) {
  // device info
  log("Name: "+idx);
  this.idx = idx;
  this.name = name;
  this.log = log;
  this.client = client;
  this.info = info;
  this.protocol = protocol;
  this.registerForUpdates(idx, this);
}


// XXX merge with Switch prototype and extract common prototype
PilightTemperatureSensor.prototype = {

  registerForUpdates: function() {
    this.log("[PilightTemperatureSensor.registerForUpdates] Registering device "+this.idx
             + " for updates");
    this.client.register(this.idx, this);
  },

  update: function(values) {
    var newValue;
    if(values === undefined) {
      return;
    }
    if('temperature' in values) {
      console.log(values);
      this.info = values;
    }
  },

  getCurrentTemperature: function(callback)  {
    var temp = parseFloat(this.info["temperature"]);
    callback(null, temp);
  },

  getServices: function() {
    var service = new Service.TemperatureSensor();
    var informationService = new Service.AccessoryInformation();


    informationService
      .setCharacteristic(Characteristic.Manufacturer, "pilight")
      .setCharacteristic(Characteristic.Model, "Thermostat Rev-2")
      .setCharacteristic(Characteristic.SerialNumber, "BIVAB-TEMP-2");

    service.getCharacteristic(Characteristic.CurrentTemperature).on(
      'get', this.getCurrentTemperature.bind(this));

    return [informationService, service];
  }
};
module.exports.accessory = PilightSwitch;
module.exports.accessory = PilightTemperatureSensor;
module.exports.platform = PilightPlatform;
