'use strict';

var request = require('request');
var sf = require('sf');
var url = require('url');
var _ = require('lodash');
var CircuitBreaker = require('./CircuitBreaker');

module.exports = getThenCache;

function getThenCache(options, debugMode, config, cache, eventHandler, stream, onError) {

    debugMode.add(options.unparsedUrl, {options: _.cloneDeep(options)});

    var start = Date.now();

    if(!options.explicitNoCache && options.cacheTTL > 0) {

        cache.get(options.cacheKey, function(err, content, oldContent) {
            if (err) return onError(err, oldContent);
            if (content) {
                var timing = Date.now() - start;
                eventHandler.logger('debug', 'CACHE HIT for key: ' + options.cacheKey,{tracer:options.tracer, responseTime: timing, pcType:options.type});
                eventHandler.stats('increment', options.statsdKey + '.cacheHit');
                debugMode.add(options.unparsedUrl, {status: 'OK', cache: 'HIT', timing: timing});
                stream.end(content);
                return;
            }

            debugMode.add(options.unparsedUrl, {cache: 'MISS'});
            eventHandler.logger('debug', 'CACHE MISS for key: ' + options.cacheKey,{tracer:options.tracer,pcType:options.type});
            eventHandler.stats('increment', options.statsdKey + '.cacheMiss');

            if(options.url == 'cache') {
                stream.end("");
                return;
            }

            CircuitBreaker(options, config, eventHandler, pipeAndCacheContent, function(err, content) {
                if (err) return onError(err, oldContent);
                var timing = Date.now() - start;
                debugMode.add(options.unparsedUrl, {status: 'OK', timing: timing});
                stream.end(content);
                cache.set(options.cacheKey, content, options.cacheTTL, function(err) {
                    eventHandler.logger('debug', 'CACHE SET for key: ' + options.cacheKey + ' @ TTL: ' + options.cacheTTL,{tracer:options.tracer,pcType:options.type});
                });
            });
        });

    } else {

        CircuitBreaker(options, config, eventHandler, pipeAndCacheContent, function(err, content) {
            if (err) return onError(err);
            var timing = Date.now() - start;
            debugMode.add(options.unparsedUrl, {status: 'OK', cache: 'DISABLED', timing: timing});
            stream.end(content);
        });

    }

    function pipeAndCacheContent(next) {

        var content = "", start = Date.now(), inErrorState = false;

        if(!url.parse(options.url).protocol) return handleError({message:'Invalid URL ' + options.url});

        options.headers['accept'] = 'text/html,application/xhtml+xml,application/xml,application/json';
        options.headers['user-agent'] = 'Compoxure-Request-Agent';

        var r = request({url: options.url, agent: false, timeout: options.timeout, headers: options.headers})
            .on('error', handleError)
            .on('data', function(data) {
                content += data.toString();
            })
            .on('response', function(response) {
                if(response.statusCode != 200) {
                    handleError({message:'status code ' + response.statusCode},response.statusCode)
                }
            })
            .on('end', function() {
                if(inErrorState) return;
                next(null, content);
                var timing = Date.now() - start;
                eventHandler.logger('debug', 'OK ' + options.url,{tracer:options.tracer, responseTime: timing, pcType:options.type});
                eventHandler.stats('timing', options.statsdKey + '.responseTime', timing);
            });

        function handleError(err, statusCode) {
            if (!inErrorState) {
                inErrorState = true;
                var message = sf('Service {url} FAILED due to {errorMessage}', {
                    url: options.url,
                    errorMessage: err.message
                });
                next({statusCode: statusCode, message: message});
            }
        }

    }


}
