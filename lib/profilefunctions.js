'use strict';

var _ = require('lodash');
var moment = require('moment-timezone');
var NodeCache = require('node-cache');
var times = require('./times');
var crypto = require('crypto');

function init(profileData) {

  var profile = { };

  profile.timeValueCache = new NodeCache({ stdTTL: 600, checkperiod: 600 });
  
  profile.loadData = function loadData(profileData) {
    if (profileData && profileData.length) {
      profile.data =  profile.convertToProfileStore(profileData);
      _.each(profile.data, function eachProfileRecord (record) {
        _.each(record.store, profile.preprocessProfileOnLoad);
      });
    }
  };
  
  profile.convertToProfileStore = function convertToProfileStore (dataArray) {
    var convertedProfiles = [];
    _.each(dataArray, function (profile) {
      if (!profile.defaultProfile) {
        var newObject = {};
        newObject.defaultProfile = 'Default';
        newObject.store = {};
        newObject.startDate = profile.startDate;
        newObject._id = profile._id;
        delete profile.startDate;
        delete profile._id;
        delete profile.created_at;
        newObject.store['Default'] = profile;
        convertedProfiles.push(newObject);
        console.log('Profile not updated yet. Converted profile:', newObject);
      } else {
        convertedProfiles.push(profile);
      }
    });
    return convertedProfiles;
  };

  profile.timeStringToSeconds = function timeStringToSeconds(time) {
    var split = time.split(':');
    return parseInt(split[0])*3600 + parseInt(split[1])*60;
  };

  // preprocess the timestamps to seconds for a couple orders of magnitude faster operation
  profile.preprocessProfileOnLoad = function preprocessProfileOnLoad(container) {
    _.each(container, function eachValue (value) {
      if( Object.prototype.toString.call(value) === '[object Array]' ) {
        profile.preprocessProfileOnLoad(value);
      }

      if (value.time) {
        var sec = profile.timeStringToSeconds(value.time);
        if (!isNaN(sec)) { value.timeAsSeconds = sec; }
      }
    });
  };
  
  profile.getValueByTime = function getValueByTime (time, valueType, spec_profile) {
    if (!time) { time = Date.now(); }

    //round to the minute for better caching
    var minuteTime = Math.round(time / 60000) * 60000;

    var cacheKey = (minuteTime + valueType + spec_profile + profile.profiletreatments_hash);
    var returnValue = profile.timeValueCache[cacheKey];

    if (returnValue) {
      return returnValue;
    }

    var valueContainer = profile.getCurrentProfile(time, spec_profile)[valueType];

    // Assumes the timestamps are in UTC
    // Use local time zone if profile doesn't contain a time zone
    // This WILL break on the server; added warnings elsewhere that this is missing
    // TODO: Better warnings to user for missing configuration

    var t = profile.getTimezone(spec_profile) ? moment(minuteTime).tz(profile.getTimezone(spec_profile)) : moment(minuteTime);

    // Convert to seconds from midnight
    var mmtMidnight = t.clone().startOf('day');
    var timeAsSecondsFromMidnight = t.clone().diff(mmtMidnight, 'seconds');

    // If the container is an Array, assume it's a valid timestamped value container

    returnValue = valueContainer;

    if( Object.prototype.toString.call(valueContainer) === '[object Array]' ) {
      _.each(valueContainer, function eachValue (value) {
        if (timeAsSecondsFromMidnight >= value.timeAsSeconds) {
          returnValue = value.value;
        }
      });
    }

	if (returnValue) { returnValue = parseFloat(returnValue); }

    profile.timeValueCache[cacheKey] = returnValue;

    return returnValue;
  };

  profile.getCurrentProfile = function getCurrentProfile(time, spec_profile) {
    time = time || new Date().getTime();
    var data = profile.hasData() ? profile.data[0] : null;
    var timeprofile = spec_profile || profile.activeProfileToTime(time);
    return data && data.store[timeprofile] ? data.store[timeprofile] : {};
  };

  profile.getUnits = function getUnits(spec_profile) {
    return profile.getCurrentProfile(null, spec_profile)['units'];
  };

  profile.getTimezone = function getTimezone(spec_profile) {
    return profile.getCurrentProfile(null, spec_profile)['timezone'];
  };

  profile.hasData = function hasData() {
    return profile.data ? true : false;
  };

  profile.getDIA = function getDIA(time, spec_profile) {
    return profile.getValueByTime(time, 'dia', spec_profile);
  };

  profile.getSensitivity = function getSensitivity(time, spec_profile) {
    return profile.getValueByTime(time, 'sens', spec_profile);
  };

  profile.getCarbRatio = function getCarbRatio(time, spec_profile) {
    return profile.getValueByTime(time, 'carbratio', spec_profile);
  };

  profile.getCarbAbsorptionRate = function getCarbAbsorptionRate(time, spec_profile) {
    return profile.getValueByTime(time, 'carbs_hr', spec_profile);
  };

  profile.getLowBGTarget = function getLowBGTarget(time, spec_profile) {
    return profile.getValueByTime(time, 'target_low', spec_profile);
  };

  profile.getHighBGTarget = function getHighBGTarget(time, spec_profile) {
    return profile.getValueByTime(time, 'target_high', spec_profile);
  };

  profile.getBasal = function getBasal(time, spec_profile) {
    return profile.getValueByTime(time, 'basal', spec_profile);
  };

  profile.updateTreatments = function updateTreatments (profiletreatments, tempbasaltreatments, combobolustreatments) {
    profile.profiletreatments = profiletreatments || [];
    profile.tempbasaltreatments = tempbasaltreatments || [];
    profile.combobolustreatments = combobolustreatments || [];
    profile.profiletreatments_hash = crypto.createHash('sha1').update(JSON.stringify(profile.profiletreatments)).digest('hex');
    profile.tempbasaltreatments_hash = crypto.createHash('sha1').update(JSON.stringify(profile.tempbasaltreatments)).digest('hex');
    profile.combobolustreatments_hash = crypto.createHash('sha1').update(JSON.stringify(profile.combobolustreatments)).digest('hex');
  };
  
  profile.activeProfileToTime = function activeProfileToTime (time) {
    if (profile.hasData()) {
      var timeprofile = profile.data[0].defaultProfile;
      time = time || new Date().getTime();
      var treatment = profile.activeProfileTreatmentToTime(time);
      if (treatment) {
        timeprofile = treatment.profile;
      }
      return timeprofile;
    }
    return null;
  };
  
  profile.activeProfileTreatmentToTime = function activeProfileTreatmentToTime(time) {
    var cacheKey = 'profile' + time + profile.profiletreatments_hash;
    var returnValue = profile.timeValueCache[cacheKey];

    if (returnValue) {
      return returnValue;
    }

    var treatment = null;
    profile.profiletreatments.forEach( function eachTreatment (t) {
        if (time > t.mills) {
          treatment = t;
        }
    });
    
    returnValue = treatment;
    profile.timeValueCache[cacheKey] = returnValue;
    return returnValue;
  };

  profile.tempBasalTreatment = function tempBasalTreatment(time) {
    var treatment = null;
    profile.tempbasaltreatments.forEach( function eachTreatment (t) {
        var duration = times.mins(t.duration || 0).msecs;
        if (time < t.mills + duration && time > t.mills) {
          treatment = t;
        }
    });
    return treatment;
  };

  profile.comboBolusTreatment = function comboBolusTreatment(time) {
    var treatment = null;
    profile.combobolustreatments.forEach( function eachTreatment (t) {
        var duration = times.mins(t.duration || 0).msecs;
        if (time < t.mills + duration && time > t.mills) {
          treatment = t;
        }
    });
    return treatment;
  };

  profile.getTempBasal = function getTempBasal(time, spec_profile) {

    var cacheKey = 'basal' + time + profile.tempbasaltreatments_hash + profile.combobolustreatments_hash + profile.profiletreatments_hash + spec_profile;
    var returnValue = profile.timeValueCache[cacheKey];

    if (returnValue) {
      return returnValue;
    }

    var basal = profile.getBasal(time, spec_profile);
    var tempbasal = basal;
    var combobolusbasal = 0;
    var treatment = profile.tempBasalTreatment(time);
    var combobolustreatment = profile.comboBolusTreatment(time);

    //special handling for absolute to support temp to 0
    if (treatment && !isNaN(treatment.absolute) && treatment.duration > 0) {
      tempbasal = Number(treatment.absolute);
    } else if (treatment && treatment.percent) {
      tempbasal = basal * (100 + treatment.percent) / 100;
    } 
    if (combobolustreatment && combobolustreatment.relative) {
      combobolusbasal = combobolustreatment.relative;
    }
    returnValue = {
      basal: basal
      , treatment: treatment
      , combobolustreatment: combobolustreatment
      , tempbasal: tempbasal
      , combobolusbasal: combobolusbasal
      , totalbasal: tempbasal + combobolusbasal
    };
    profile.timeValueCache[cacheKey] = returnValue;
    return returnValue;
  };

  profile.listBasalProfiles = function listBasalProfiles () {
    var profiles = [];
    if (profile.hasData()) {
      var current = profile.activeProfileToTime();
      profiles.push(current);
      
      for (var key in profile.data[0].store) {
        if (profile.data[0].store.hasOwnProperty(key) && key !== current) {
            profiles.push(key);
        }
      }
    }
    return profiles;
  };
  
  
  if (profileData) { profile.loadData(profileData); }
  // init treatments array
  profile.updateTreatments([], []);

  return profile;
}

module.exports = init;