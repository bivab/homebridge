var types = require("../lib/HAP-NodeJS/accessories/types.js");
var request = require('request');
var net = require('net')
/* TODO:
 * - send keepalive
 * - auto reconnect on disconnect
 * - support more devices
 */


function PilightPlatform(log, config){
  this.name = config['name']
  this.host = config['host']
  this.port = config['port']
  this.protocol = config['protocol']
  this.http_port = config['http-port']

  this.log = log;
}


function PilightClient(log, platform) {
    var that= this;
    var bootstrap = function() {
        log('connected to server!');
        var cmd = {
          "action": "identify",
          "options": {
            "config": 1
          }
        };
        that.send(cmd);
    }

    this.log = log;
    this.registry = [];
    this.socket = net.connect({host:platform.host, port:platform.port}, bootstrap);

    this.socket.on('data', function(data) {
      try {
        data = JSON.parse(data);
      } catch(e) {
        if (e instanceof SyntaxError) { that.log("SyntaxError in " + data.toString()); }
        else { that.log("Error " + JSON.stringify(e)); }
      }

      if(data['origin'] !== 'update') {
        return
      }
      that.updateDevices(data['devices'], data['values']);
    });

    this.socket.on('end', function() {
      that.log('disconnected from server');
    });
}
PilightClient.prototype = {
  send: function(cmd) {
    var msg = JSON.stringify(cmd);
    this.log("[PilightClient.send] "+msg);
    this.socket.write(msg);
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
      dev.updateCharacteristics(values);
    }
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
              case "elro_800_switch":
                accessory = PilightSwitch;
                break;
              case 'openweathermap':
                accessory = PilightThermostat;
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
  this.registry = [];
  this.info = info;
  this.protocol = protocol;
}


PilightSwitch.prototype = {

  registerForUpdates: function(characteristic) {
    this.log("[PilightSwitch.registerForUpdates] Registering device "+this.idx
             + " for updates on characteristic '"+characteristic.manfDescription+"'");

    this.registry.push(characteristic);
    this.client.register(this.idx, this);
  },

  updateCharacteristics: function(values) {
    var newValue = (values['state'] === 'on')*1;
    for(var c of this.registry) {
      if(c.value === newValue) {
        this.log("[PilightSwitch.updateCharacteristics] No state change "
                 + "detected on characteristic, skiping event");
        continue;
      }
      this.log("[PilightSwitch.updateCharacteristics] Updating device "
               +this.name + " to value "+newValue+" on characteristic '"
               +JSON.stringify(c.manfDescription)+"'");
      c.updateValue(newValue);
    }
  },

  setPowerState: function(powerOn) {
    var that = this;
    this.log("[PilightSwitch.setPowerState] "+powerOn);
    this.client.send({
          "action": "control",
          "code": {
            "device": that.idx,
            "state": (powerOn)?"on":"off"
          }});
  },

  getServices: function() {
    var that = this;
    return [{
      sType: types.ACCESSORY_INFORMATION_STYPE,
      characteristics: [{
        cType: types.NAME_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: that.name,
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Name of the accessory",
        designedMaxLength: 255
      },{
        cType: types.MANUFACTURER_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: "pilight",
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Manufacturer",
        designedMaxLength: 255
      },{
        cType: types.MODEL_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: "Rev-1",
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Model",
        designedMaxLength: 255
      },{
        cType: types.SERIAL_NUMBER_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: "BIVAB-PO-1",
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "SN",
        designedMaxLength: 255
      },{
        cType: types.IDENTIFY_CTYPE,
        onUpdate: null,
        perms: ["pw"],
        format: "bool",
        initialValue: false,
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Identify Accessory",
        designedMaxLength: 1
      }]
    },{
      sType: types.OUTLET_STYPE,
      characteristics: [{
        cType: types.NAME_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: that.name + " outlet service",
        supportEvents: true,
        supportBonjour: false,
        manfDescription: "Name of service",
        designedMaxLength: 255
      },{
        cType: types.POWER_STATE_CTYPE,
        onUpdate: function(value) { that.setPowerState(value)},
        onRegister: function(characteristic) { that.registerForUpdates(characteristic) },
        perms: ["pw","pr","ev"],
        format: "bool",
        initialValue: (this.state==='on')?1:0,
        supportEvents: true,
        supportBonjour: false,
        manfDescription: "Change the power state of the outlet",
        designedMaxLength: 1
      },{
        cType: types.OUTLET_IN_USE_CTYPE,
        onUpdate: function(value) { that.setPowerState(value)},
        perms: ["pr","ev"],
        format: "bool",
        initialValue: true,
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Turn On the Light",
        designedMaxLength: 1
      }]
    }];
  }
};

// XXX refactory and merge with Switch
function PilightThermostat(log, idx, name, protocol, info, client) {
  // device info
  log("Name: "+idx);
  this.idx = idx;
  this.name = name;
  this.log = log;
  this.client = client;
  this.registry = [];
  this.info = info;
  this.protocol = protocol;
}


// XXX merge with Switch prototype and extract common prototype
PilightThermostat.prototype = {

  registerForUpdates: function(characteristic) {
    this.log("[PilightThermostat.registerForUpdates] Registering device "+this.idx
             + " for updates on characteristic '"+characteristic.manfDescription+"'");

    this.registry.push(characteristic);
    this.client.register(this.idx, this);
  },

  updateCharacteristics: function(values) {
    this.log(values);
    var newValue;
    for(var c of this.registry) {
      switch(c.type) {
        case types.CURRENT_TEMPERATURE_CTYPE:
          newValue = values['temperature'];
          break;
        case types.CURRENT_RELATIVE_HUMIDITY_CTYPE:
          newValue = values['humidity'];
          break;
      }
      if(newValue === undefined || c.value === newValue) {
        this.log("[PilightThermostat.updateCharacteristics] No state change "
                 + "detected on characteristic, skiping event");
        continue;
      }
      this.log("[PilightThermostat.updateCharacteristics] Updating device "
               +this.name + " to value "+newValue+" on characteristic '"
               +JSON.stringify(c.manfDescription)+"'");
    }
    c.updateValue(newValue);
  },

  getServices: function() {
    var that = this;
    return [{
      sType: types.ACCESSORY_INFORMATION_STYPE,
      characteristics: [{
        cType: types.NAME_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: that.name + "Thermostat 1",
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Bla",
        designedMaxLength: 255
        },{
        cType: types.MANUFACTURER_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: "Oltica",
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Bla",
        designedMaxLength: 255
        },{
        cType: types.MODEL_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: "Rev-1",
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Bla",
        designedMaxLength: 255
        },{
        cType: types.SERIAL_NUMBER_CTYPE,
        onUpdate: null,
        perms: ["pr"],
        format: "string",
        initialValue: "A1S2NASF88EW",
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Bla",
        designedMaxLength: 255
        },{
        cType: types.IDENTIFY_CTYPE,
        onUpdate: null,
        perms: ["pw"],
        format: "bool",
        initialValue: false,
        supportEvents: false,
        supportBonjour: false,
        manfDescription: "Identify Accessory",
        designedMaxLength: 1
      }]
      },{
      sType: types.THERMOSTAT_STYPE,
      characteristics: [{
          cType: types.NAME_CTYPE,
          onUpdate: null,
          perms: ["pr"],
          format: "string",
          initialValue: that.name + "Thermostat Control",
          supportEvents: false,
          supportBonjour: false,
          manfDescription: "Bla",
          designedMaxLength: 255
        },{
          cType: types.CURRENTHEATINGCOOLING_CTYPE,
          perms: ["pr","ev"],
          format: "int",
          initialValue: 0,
          supportEvents: false,
          supportBonjour: false,
          manfDescription: "Current Mode",
          designedMaxLength: 1,
          designedMinValue: 0,
          designedMaxValue: 2,
          designedMinStep: 1,
        },{
          cType: types.TARGETHEATINGCOOLING_CTYPE,
          perms: ["pr","ev"],
          format: "int",
          initialValue: 0,
          supportEvents: false,
          supportBonjour: false,
          manfDescription: "Target Mode",
          designedMinValue: 0,
          designedMaxValue: 3,
          designedMinStep: 1,
        },{
          cType: types.CURRENT_TEMPERATURE_CTYPE,
          onRegister: function(characteristic) { that.registerForUpdates(characteristic) },
          onUpdate: null,
          perms: ["pr","ev"],
          format: "int",
          initialValue: parseFloat(that.info['temperature']),
          supportEvents: false,
          supportBonjour: false,
          manfDescription: "Current Temperature",
          unit: "celsius"
        },{
          cType: types.TARGET_TEMPERATURE_CTYPE,
          onUpdate: null,
          perms: ["pr","ev"],
          format: "int",
          initialValue: parseFloat(that.info['temperature']),
          supportEvents: false,
          supportBonjour: false,
          manfDescription: "Target Temperature",
          designedMinValue: 16,
          designedMaxValue: 38,
          designedMinStep: 1,
          unit: "celsius"
        },{
          cType: types.CURRENT_RELATIVE_HUMIDITY_CTYPE,
          onRegister: function(characteristic) { that.registerForUpdates(characteristic) },
          onUpdate: null,
          perms: ["pr","ev"],
          format: "float",
          initialValue: parseFloat(that.info['humidity']),
          supportEvents: false,
          supportBonjour: false,
          manfDescription: "Current relative humidity",
          unit: "percentage",
          designedMinValue: 0,
          designedMaxValue: 100,
          designedMinStep: 1
        },{
          cType: types.TEMPERATURE_UNITS_CTYPE,
          perms: ["pr","ev"],
          format: "int",
          initialValue: 0,
          supportEvents: false,
          supportBonjour: false,
          manfDescription: "Unit",
        }]
      }];
  }
};
module.exports.accessory = [PilightSwitch, PilightThermostat];
module.exports.platform = PilightPlatform;
