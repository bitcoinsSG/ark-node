'use strict';

var async = require('async');
var path = require('path');
var Router = require('../helpers/router.js');

// Private fields
var modules, library, self, __private = {}, shared = {};

__private.loaded = false;

// Constructor
function Server (cb, scope) {
	library = scope;
	self = this;

	setImmediate(cb, null, self);
}

// Private methods
__private.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) { return next(); }
		res.status(500).send({success: false, error: 'Blockchain is loading'});
	});

	// router.get('/', function (req, res) {
	// 	if (__private.loaded) {
	// 		res.render('wallet.html', {layout: false});
	// 	} else {
	// 		res.render('loading.html');
	// 	}
	// });

	router.use(function (req, res, next) {
		if (req.url.indexOf('/api/') === -1 && req.url.indexOf('/peer/') === -1) {
			return res.redirect('/');
		}
		next();
	});

	library.network.app.use('/', router);
};

// Public methods

// Events
//
//__EVENT__ `onBind`

//
Server.prototype.onBind = function (scope) {
	modules = scope;
};

//
//__EVENT__ `onAttachPublicApi`

//
Server.prototype.onAttachPublicApi = function () {
 	__private.attachApi();
};

//
//__API__ `cleanup`

//
Server.prototype.cleanup = function (cb) {
	return setImmediate(cb);
};

// Shared

// Export
module.exports = Server;
