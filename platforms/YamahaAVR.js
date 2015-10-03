var types = require("HAP-NodeJS/accessories/types.js");
var inherits = require('util').inherits;
var debug = require('debug')('YamahaAVR');
var Service = require("HAP-NodeJS").Service;
var Characteristic = require("HAP-NodeJS").Characteristic;
var Yamaha = require('yamaha-nodejs');
var Q = require('q');
var mdns = require('mdns');
//workaround for raspberry pi
var sequence = [
    mdns.rst.DNSServiceResolve(),
    'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({families:[4]}),
    mdns.rst.makeAddressesUnique()
];

function YamahaAVRPlatform(log, config){
    this.log = log;
    this.config = config;
    this.playVolume = config["play_volume"];
    this.minVolume = config["min_volume"] || -50.0;
    this.maxVolume = config["max_volume"] || -20.0;
    this.gapVolume = this.maxVolume - this.minVolume;
    this.setMainInputTo = config["setMainInputTo"];
    this.expectedDevices = config["expected_devices"] || 100;
    this.discoveryTimeout = config["discovery_timeout"] || 30;
    this.browser = mdns.createBrowser(mdns.tcp('http'), {resolverSequence: sequence});
}

// Custom Characteristics and service...

YamahaAVRPlatform.AudioVolume = function() {
  Characteristic.call(this, 'Audio Volume', '00001001-0000-1000-8000-135D67EC4377');
  this.format = 'uint8';
  this.unit = 'percentage';
  this.maximumValue = 100;
  this.minimumValue = 0;
  this.stepValue = 1;
  this.readable = true;
  this.writable = true;
  this.supportsEventNotification = true;
  this.value = this.getDefaultValue();
};
inherits(YamahaAVRPlatform.AudioVolume, Characteristic);

YamahaAVRPlatform.Muting = function() {
  Characteristic.call(this, 'Muting', '00001002-0000-1000-8000-135D67EC4377');
  this.format = 'bool';
  this.readable = true;
  this.writable = true;
  this.supportsEventNotification = true;
  this.value = this.getDefaultValue();
};
inherits(YamahaAVRPlatform.Muting, Characteristic);

YamahaAVRPlatform.AudioDeviceService = function(displayName, subtype) {
  Service.call(this, displayName, '00000001-0000-1000-8000-135D67EC4377', subtype);

  // Required Characteristics
  this.addCharacteristic(YamahaAVRPlatform.AudioVolume);

  // Optional Characteristics
  this.addOptionalCharacteristic(YamahaAVRPlatform.Muting);
};
inherits(YamahaAVRPlatform.AudioDeviceService, Service);


YamahaAVRPlatform.prototype = {
    accessories: function(callback) {
        this.log("Getting Yamaha AVR devices.");
        var that = this;

        var browser = this.browser;
        browser.stop();
        browser.removeAllListeners('serviceUp'); // cleanup listeners
        var accessories = [];
        var timer, timeElapsed = 0, checkCyclePeriod = 5000;
        
        browser.on('serviceUp', function(service){
            var name = service.name;
            //console.log('Found HTTP service "' + name + '"');
            // We can't tell just from mdns if this is an AVR...
            if (service.port != 80) return; // yamaha-nodejs assumes this, so finding one on another port wouldn't do any good anyway.
            var yamaha = new Yamaha(service.host);
            yamaha.getSystemConfig().then(function(sysConfig){
                var sysModel = sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0];
                var sysId = sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0];
                that.log("Found Yamaha " + sysModel + " - " + sysId + ", \"" + name + "\"");
                var accessory = new YamahaAVRAccessory(that.log, that.config, service, yamaha, sysConfig);
                accessories.push(accessory);
                if(accessories.length >= this.expectedDevices)
                    timeoutFunction(); // We're done, call the timeout function now.
                //callback([accessory]);
            }, function(err){
                return;
            });
        });       
        browser.start();
        
        // The callback can only be called once...so we'll have to find as many as we can
        // in a fixed time and then call them in.
        var timeoutFunction = function(){
            if(accessories.length >= that.expectedDevices){
                clearTimeout(timer);
            } else {
                timeElapsed += checkCyclePeriod;
                if(timeElapsed > that.discoveryTimeout * 1000){
                    that.log("Waited " + that.discoveryTimeout + " seconds, stopping discovery.");
                } else {
                    timer = setTimeout(timeoutFunction, checkCyclePeriod);
                    return;
                }
            }
            browser.stop();
            browser.removeAllListeners('serviceUp');
            that.log("Discovery finished, found " + accessories.length + " Yamaha AVR devices.");
            callback(accessories);
        };
        timer = setTimeout(timeoutFunction, checkCyclePeriod);
    }
};

function YamahaAVRAccessory(log, config, mdnsService, yamaha, sysConfig) {
    this.log = log;
    this.config = config;
    this.mdnsService = mdnsService;
    this.yamaha = yamaha;
    this.sysConfig = sysConfig;
    
    this.name = mdnsService.name;
    this.serviceName = mdnsService.name + " Speakers";
    this.setMainInputTo = config["setMainInputTo"];
    this.playVolume = this.config["play_volume"];
    this.minVolume = config["min_volume"] || -50.0;
    this.maxVolume = config["max_volume"] || -20.0;
    this.gapVolume = this.maxVolume - this.minVolume;
}

YamahaAVRAccessory.prototype = {

    setPlaying: function(playing) {
        var that = this;
        var yamaha = this.yamaha;

        if (playing) {
            
            return yamaha.powerOn().then(function(){
                if (that.playVolume) return yamaha.setVolumeTo(that.playVolume*10);
                else return Q(); 
            }).then(function(){
                if (that.setMainInputTo) return yamaha.setMainInputTo(that.setMainInputTo);
                else return Q(); 
            }).then(function(){
                if (that.setMainInputTo == "AirPlay") return yamaha.SendXMLToReceiver(
                    '<YAMAHA_AV cmd="PUT"><AirPlay><Play_Control><Playback>Play</Playback></Play_Control></AirPlay></YAMAHA_AV>'
                );
                else return Q();
            });
        }
        else {
            return yamaha.powerOff();
        }
    },

    getServices: function() {
        var that = this;
        var informationService = new Service.AccessoryInformation();
        var yamaha = this.yamaha;
    
        informationService
                .setCharacteristic(Characteristic.Name, this.name)
                .setCharacteristic(Characteristic.Manufacturer, "Yamaha")
                .setCharacteristic(Characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
                .setCharacteristic(Characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);
        
        var switchService = new Service.Switch("Power State");
        switchService.getCharacteristic(Characteristic.On)
                .on('get', function(callback, context){
                    yamaha.isOn().then(function(result){
                        callback(false, result);
                    }.bind(this));
                }.bind(this))
                .on('set', function(powerOn, callback){
                    this.setPlaying(powerOn).then(function(){
                        callback(false, powerOn); 
                    }, function(error){
                        callback(error, !powerOn); //TODO: Actually determine and send real new status.
                    });
                }.bind(this));
        
        var audioDeviceService = new YamahaAVRPlatform.AudioDeviceService("Audio Functions");
        audioDeviceService.getCharacteristic(YamahaAVRPlatform.AudioVolume)
                .on('get', function(callback, context){
                    yamaha.getBasicInfo().done(function(basicInfo){
                        var v = basicInfo.getVolume()/10.0;
                        var p = 100 * ((v - that.minVolume) / that.gapVolume);
                        p = p < 0 ? 0 : p > 100 ? 100 : Math.round(p);
                        debug("Got volume percent of " + p + "%");
                        callback(false, p);
                    });
                })
                .on('set', function(p, callback){
                    var v = ((p / 100) * that.gapVolume) + that.minVolume;
                    v = Math.round(v*10.0);
                    debug("Setting volume to " + v);
                    yamaha.setVolumeTo(v).then(function(){
                        callback(false, p);
                    });
                })
                .getValue(null, null); // force an asynchronous get
                
        
        return [informationService, switchService, audioDeviceService];
        
    }
};

module.exports.accessory = YamahaAVRAccessory;
module.exports.platform = YamahaAVRPlatform;
