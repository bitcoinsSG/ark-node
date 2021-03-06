'use strict';

var async = require('async');
var bignum = require('../helpers/bignum.js');
var constants = require('../helpers/constants.js');
var ip = require('ip');
var Router = require('../helpers/router.js');
var schema = require('../schema/loader.js');
var sql = require('../sql/loader.js');

require('colors');

// Private fields
var modules, library, self, __private = {}, shared = {};

__private.network = {
	height: 0, // Network height
	peers: [], // "Good" peers and with height close to network height
};

__private.blockchainReady = false;
__private.noShutdownRequired = false;
__private.lastBlock = null;
__private.genesisBlock = null;
__private.forceRemoveBlocks = 0;
__private.total = 0;
__private.blocksToSync = 0;
__private.syncFromNetworkIntervalId = null;

// Constructor
function Loader (cb, scope) {
	library = scope;
	self = this;

	__private.genesisBlock = __private.lastBlock = library.genesisblock;

	setImmediate(cb, null, self);
}

// Private methods
__private.attachApi = function () {
	var router = new Router();

	router.get('/status/ping', function (req, res) {
		__private.ping(function(status, body) {
			return res.status(status).json(body);
		});
	});

	router.map(shared, {
		'get /status': 'status',
		'get /status/sync': 'sync'
	});

	library.network.app.use('/api/loader', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) { return next(); }
		library.logger.error('API error ' + req.url, err);
		res.status(500).send({success: false, error: 'API error: ' + err.message});
	});
};

__private.syncFromNetworkTrigger = function (turnOn) {
	__private.noShutdownRequired = turnOn;

	if (!turnOn && __private.syncFromNetworkIntervalId) {
		clearTimeout(__private.syncFromNetworkIntervalId);
		__private.syncFromNetworkIntervalId = null;
	}
	if (turnOn && !__private.syncFromNetworkIntervalId) {
		setImmediate(function nextSyncTrigger () {
			library.network.io.sockets.emit('loader/sync', {
				blocks: __private.blocksToSync,
				height: modules.blocks.getLastBlock().height
			});
			__private.syncFromNetworkIntervalId = setTimeout(nextSyncTrigger, 1000);
		});
	}
};
//
// __private.loadSignatures = function (cb) {
// 	modules.transport.getFromRandomPeer({
// 		api: '/signatures',
// 		method: 'GET'
// 	}, function (err, res) {
// 		if (err) {
// 			return setImmediate(cb);
// 		}
//
// 		library.schema.validate(res.body, schema.loadSignatures, function (err) {
// 			if (err) {
// 				return setImmediate(cb);
// 			}
//
// 			library.sequence.add(function (cb) {
// 				async.eachSeries(res.body.signatures, function (signature, cb) {
// 					async.eachSeries(signature.signatures, function (s, cb) {
// 						modules.multisignatures.processSignature({
// 							signature: s,
// 							transaction: signature.transaction
// 						}, function (err) {
// 							return setImmediate(cb);
// 						});
// 					}, cb);
// 				}, cb);
// 			}, cb);
// 		});
// 	});
// };

__private.loadUnconfirmedTransactions = function (cb) {
	modules.transport.getFromRandomPeer({
		api: '/transactions',
		method: 'GET'
	}, function (err, res) {
		if (err) {
			return setImmediate(cb, err);
		}

		var report = library.schema.validate(res.body, schema.loadUnconfirmedTransactions);

		if (!report) {
			return setImmediate(cb, "Transactions list is not conform");
		}

		var peer = modules.peers.inspect(res.peer);

		var transactions = res.body.transactions;

		library.bus.message("transactionsReceived", transactions, "network", cb);

	});
};

__private.loadBlockChain = function () {

	var offset = 0, limit = Number(library.config.loading.loadPerIteration) || 1000;
	var verify = Boolean(library.config.loading.verifyOnLoading);

	function load (count) {
		verify = true;
		__private.total = count;

		library.logic.account.removeTables(function (err) {
			if (err) {
				throw err;
			} else {
				library.logic.account.createTables(function (err) {
					if (err) {
						throw err;
					} else {
						async.until(
							function () {
								return count < offset;
							},
							function (cb) {
								if (count > 1) {
									library.logger.info('Rebuilding blockchain, current block height: '  + (offset + 1));
								}
								modules.blocks.loadBlocksOffset(limit, offset, verify, function (err, lastBlock) {
									offset = offset + limit;
									__private.lastBlock = lastBlock;
									return cb(err, lastBlock);
								});
							},
							function (err, lastBlock) {
								if (err) {
									library.logger.error("error:",err);
									if (__private.lastBlock) {
										library.logger.error('Blockchain failed at: ' + __private.lastBlock.height);
										modules.blocks.simpleDeleteAfterBlock(__private.lastBlock.id, function (err, res) {
											library.logger.error('Blockchain clipped');
										});
									}
								}
								library.bus.message('databaseLoaded', __private.lastBlock);
							}
						);
					}
				});
			}
		});
	}

	function reload (count, message) {
		if (message) {
			library.logger.warn(message);
			library.logger.warn('Recreating memory tables');
		}
		load(count);
	}

	library.db.query(sql.countBlocks).then(function(rows){

		if(rows[0].count == 1){
			load(rows[0].count);
		}
		else {
			modules.blocks.loadLastBlock(function (err, block) {
				if (err) {
					return reload(count, err || 'Failed to load last block');
				} else {
					__private.lastBlock = block;
					library.bus.message('databaseLoaded', block);
				}
			});
		}
	});

	//
	// function checkMemTables (t) {
	// 	var promises = [
	// 		t.one(sql.countBlocks),
	// 		t.one(sql.countMemAccounts),
	// 		t.query(sql.getMemRounds)
	// 	];
	//
	// 	return t.batch(promises);
	// }
	//
	// library.db.task(checkMemTables).then(function (results) {
	// 	library.logger.info('checkMemTables', results);
	// 	var count = results[0].count;
	// 	var missed = !(results[1].count);
	//
	// 	library.logger.info('Blocks ' + count);
	//
	// 	var round = modules.rounds.getRoundFromHeight(count);
	//
	// 	if (library.config.loading.snapshot !== undefined || library.config.loading.snapshot > 0) {
	// 		library.logger.info('Snapshot mode enabled');
	// 		verify = true;
	//
	// 		if (isNaN(library.config.loading.snapshot) || library.config.loading.snapshot >= round) {
	// 			library.config.loading.snapshot = round;
	//
	// 			if ((count === 1) || (count % constants.activeDelegates > 0)) {
	// 				library.config.loading.snapshot = (round > 1) ? (round - 1) : 1;
	// 			}
	// 		}
	//
	// 		library.logger.info('Snapshotting to end of round: ' + library.config.loading.snapshot);
	// 	}
	//
	// 	if (count === 1) {
	// 		return reload(count);
	// 	}
	//
	// 	if (verify) {
	// 		return reload(count, 'Blocks verification enabled');
	// 	}
	//
	// 	if (missed) {
	// 		return reload(count, 'Detected missed blocks in mem_accounts');
	// 	}
	//
	// 	var unapplied = results[2].filter(function (row) {
	// 		return (row.round !== String(round));
	// 	});
	//
	// 	if (unapplied.length > 0) {
	//
	// 		return reload(count, 'Detected unapplied rounds in mem_round');
	// 	}
	//
	// 	function updateMemAccounts (t) {
	// 		var promises = [
	// 			t.none(sql.updateMemAccounts),
	// 			t.query(sql.getOrphanedMemAccounts),
	// 			t.query(sql.getDelegates)
	// 		];
	//
	// 		return t.batch(promises);
	// 	}
	//
	// 	library.db.task(updateMemAccounts).then(function (results) {
	// 		if (results[1].length > 0) {
	// 			return reload(count, 'Detected orphaned blocks in mem_accounts');
	// 		}
	//
	// 		if (results[2].length === 0) {
	// 			return reload(count, 'No delegates found');
	// 		}
	//
	// 		modules.blocks.loadLastBlock(function (err, block) {
	// 			if (err) {
	// 				return reload(count, err || 'Failed to load last block');
	// 			} else {
	// 				__private.lastBlock = block;
	// 				library.bus.message('databaseLoaded', block);
	// 			}
	// 		});
	// 	});
	// }).catch(function (err) {
	// 	library.logger.error("error:",err);
	// 	return process.exit(0);
	// });
};

__private.shuffle = function(array) {
	var currentIndex = array.length, temporaryValue, randomIndex;

	// While there remain elements to shuffle...
	while (0 !== currentIndex) {

		// Pick a remaining element...
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;

		// And swap it with the current element.
		temporaryValue = array[currentIndex];
		array[currentIndex] = array[randomIndex];
		array[randomIndex] = temporaryValue;
	}

	return array;
}

__private.loadBlocksFromNetwork = function (cb) {
	var tryCount = 0;
	//var loaded = false;

	var network = __private.network;

	var peers=__private.shuffle(network.peers).sort(function(p1, p2){
		if(p1.height==p2.height){
			return p1.blockheader.id<p2.blockheader.id;
		}
		else{
			return p1.height<p2.height;
		}
	});



	//TODO: tryCount is accounting for 2 use cases :
	// - no more blocks downloaded
	// - error finding common blocks
	// should be separated because the strategies are different.
	async.whilst(
		function () {


			//return !loaded && (tryCount < 5) && (peers.length > tryCount);
			return modules.blockchain.isMissingNewBlock() && (tryCount < 3) && (peers.length > tryCount);
		},
		function (next) {

			var peer = peers[tryCount];
			var lastBlock = modules.blockchain.getLastBlock();

			async.waterfall([
				function getCommonBlock (seriesCb) {
					if (lastBlock.height === 1){
						return seriesCb();
					}
					__private.blocksToSync = peer.height - lastBlock.height;
					library.logger.debug('Looking for common block with: ' + peer.string);
					modules.blocks.getCommonBlock(peer, lastBlock.height, function (err, result) {
						if (err) {
							tryCount++;
							library.logger.error(err, result);
							return seriesCb(err);
						}
						else if (result.lastBlockHeight && result.lastBlockHeight <= lastBlock.height){
							tryCount++;
							return seriesCb("No new block from " + peer.string);
						}
						else if (!result.common) {
							tryCount++;
							modules.peers.remove(peer.ip, peer.port);
							return seriesCb("Detected forked chain, no common block with " + peer.string);
						}
						else{
							library.logger.info(['Found common block ', result.common.height, 'with', peer.string].join(' '));
							return seriesCb();
						}
					});
				},
				function loadBlocks (seriesCb) {
					modules.blocks.loadBlocksFromPeer(peer, seriesCb);
				}
			], function (err, lastBlock) {
				if(!lastBlock){
					tryCount++;
					library.logger.info("No new block received from " + peer.string);
				}
				else{
					if(err){
						library.logger.error(err, lastBlock);
					}
					library.logger.info("Processsed blocks to height " + lastBlock.height + " from " + peer.string);
				}


				next();
			});
		},
		function (err) {
			if (err) {
				library.logger.error('Failed to load blocks from network', err);
				return setImmediate(cb, err);
			} else {
				return setImmediate(cb, null, __private.lastBlock);
			}
		}
	);

	// async.whilst(
	// 	function () {
	// 		return !loaded && (errorCount < 5) && (peers.length > errorCount+1);
	// 	},
	// 	function (next) {
	// 		var peer = peers[errorCount];
	// 		var lastBlock = modules.blocks.getLastBlock();
	//
	// 		function loadBlocks (cb) {
	// 			__private.blocksToSync = peer.height - lastBlock.height;
	// 			modules.blocks.loadBlocksFromPeer(peer, function (err, lastValidBlock) {
	// 				if (err) {
	// 					library.logger.error(err.toString());
	// 					errorCount += 1;
	// 					return setImmediate(cb, 'Unable to load blocks from ' + peer.string);
	// 				}
	// 				loaded = (lastValidBlock.height == modules.blocks.getLastBlock().height) || (lastValidBlock.id == __private.lastBlock.id);
	// 				__private.lastBlock = lastValidBlock;
	// 				lastValidBlock = null;
	// 				return setImmediate(cb);
	// 			});
	// 		}
	// 		// we make sure we are on same chain
	// 		function getCommonBlock (cb) {
	// 			// get last version of peer header
	// 			__private.blocksToSync = peer.height - lastBlock.height;
	// 			library.logger.info('Looking for common block with: ' + peer.string);
	// 			modules.blocks.getCommonBlock(peer, lastBlock.height, function (err, commonBlock) {
	// 				if (!commonBlock) {
	// 					if (err) {
	// 						library.logger.error(err.toString());
	// 					}
	// 					modules.peers.remove(peer.ip, peer.port);
	// 					return setImmediate(cb, "Detected forked chain, no common block with: " + peer.string);
	// 				} else {
	// 					library.logger.info(['Found common block:', commonBlock.id, 'with:', peer.string].join(' '));
	// 					return setImmediate(cb);
	// 				}
	// 			});
	// 		}
	//
	// 		if (lastBlock.height === 1) {
	// 			loadBlocks(next);
	// 	 	} else {
	// 		 	getCommonBlock(function(cb, err){
	// 				if(err){
	// 					next(err);
	// 				}
	// 				else{
	// 					loadBlocks(function(err){
	// 						next(err);
	// 					});
	// 				}
	//
	// 			});
	// 		}
	// 	},
	// 	function (err) {
	// 		if (err) {
	// 			library.logger.error('Failed to load blocks from network', err);
	// 			return setImmediate(cb, err);
	// 		} else {
	// 			return setImmediate(cb);
	// 		}
	// 	}
	// );
};

__private.syncFromNetwork = function (cb) {
	if(self.syncing()){
		library.logger.info('Already syncing');
		return setImmediate(cb);
	}
	library.logger.debug('Starting sync');
	__private.syncFromNetworkTrigger(true);

	async.series({
		undoUnconfirmedList: function (seriesCb) {
			library.logger.debug('Undoing unconfirmed transactions before sync');
			return modules.transactionPool.undoUnconfirmedList([], seriesCb);
		},
		loadBlocksFromNetwork: function (seriesCb) {
			return __private.loadBlocksFromNetwork(seriesCb);
		},
		applyUnconfirmedList: function (seriesCb) {
			library.logger.debug('Applying unconfirmed transactions after sync');
			return modules.transactionPool.applyUnconfirmedList(seriesCb);
		}
	}, function (err) {
		__private.syncFromNetworkTrigger(false);
		__private.blocksToSync = 0;

		library.logger.debug('Finished sync');
		return setImmediate(cb, err);
	});
};

// Given a list of peers with associated blockchain height (heights = {peer: peer, height: height}), we find a list of good peers (likely to sync with), then perform a histogram cut, removing peers far from the most common observed height. This is not as easy as it sounds, since the histogram has likely been made accross several blocks, therefore need to aggregate).
__private.findGoodPeers = function (heights) {
	// Removing unreachable peers
	heights = heights.filter(function (item) {
		return item != null;
	});

	// Ordering the peers with descending height
	heights = heights.sort(function (a,b) {
		return b.height - a.height;
	});

	var histogram = {};
	var max = 0;
	var height;

	// Aggregating height by 2. TODO: To be changed if node latency increases?
	var aggregation = 2;

	// Histogram calculation, together with histogram maximum
	for (var i in heights) {
		var val = parseInt(heights[i].height / aggregation) * aggregation;
		histogram[val] = (histogram[val] ? histogram[val] : 0) + 1;

		if (histogram[val] > max) {
			max = histogram[val];
			height = val;
		}
	}

	// Performing histogram cut of peers too far from histogram maximum
	// TODO: to fine tune
	var peers = heights.filter(function (item) {
		return item && Math.abs(height - item.height) < aggregation + 3;
	}).map(function (item) {
		item.peer.height = item.height;
		item.peer.blockheader = item.header;
		modules.peers.update(item.peer);
		return item.peer;
	});
	return {height: height, peers: peers};
};

// Public methods

//
//__API__ `triggerBlockRemoval`

//
Loader.prototype.triggerBlockRemoval = function(number){
	__private.forceRemoveBlocks = number;
};


// get the smallest block timestamp at the higjest height from network
//
//__API__ `getNetworkSmallestBlock`

//
Loader.prototype.getNetworkSmallestBlock = function(){
	var bestBlock = null;
	__private.network.peers.forEach(function(peer){
		if(!bestBlock){
			bestBlock=peer.blockheader;
		}
		else if(!modules.system.isMyself(peer)){
			if(peer.blockheader.height>bestBlock.height){
				bestBlock=peer.blockheader;
			}
			else if(peer.blockheader.height == bestBlock.height && peer.blockheader.timestamp < bestBlock.timestamp){
				bestBlock=peer.blockheader;
			}
		}
	});
	return bestBlock;
}

// Rationale:
// - We pick 100 random peers from a random peer (could be unreachable).
// - Then for each of them we grab the height of their blockchain.
// - With this list we try to get a peer with sensibly good blockchain height (see __private.findGoodPeers for actual strategy).
//
//__API__ `getNetwork`

//
Loader.prototype.getNetwork = function (force, cb) {
	// If __private.network.height is not so far (i.e. 1 round) from current node height, just return cached __private.network.
	// If node is forging, do it more often (every block?)
	var distance = modules.delegates.isActiveDelegate() ? 2 : 51;

	if (!force && __private.network.height > 0 && Math.abs(__private.network.height - modules.blocks.getLastBlock().height) < distance) {
		return cb(null, __private.network);
	}

	// Fetch a list of 100 random peers
	//modules.peers.list({limit:100}, function (err, peers) {
	 modules.transport.getFromRandomPeer({
	 	api: '/list',
	 	method: 'GET'
	 }, function (err, res) {
		if (err) {
			library.logger.info('Failed to connect properly with network', err);
			return cb(err);
		}


		var peers = res.body.peers;

		library.schema.validate({peers:peers}, schema.getNetwork.peers, function (err) {
			if (err) {
				return cb(err);
			}

			peers = __private.shuffle(peers);

			library.logger.debug(['Received', peers.length, 'peers from'].join(' '), res.peer.string);

			// Validate each peer and then attempt to get its height
			async.map(peers, function (peer, cb) {
				var peerIsValid = library.schema.validate(modules.peers.inspect(peer), schema.getNetwork.peer);

				if (peerIsValid) {
					modules.transport.getFromPeer(peer, {
						api: '/height',
						method: 'GET',
						timeout: 2000
					}, function (err, res) {
						if (err) {

							library.logger.warn('Failed to get height from peer', peer.string);
							library.logger.warn("Error",err);
							return cb();
						}

						var verification = false;

						try {
							// TODO: also check that the delegate was legit to forge the block ?
							// likely too much work since in the end we use only a few peers of the list
							// or maybe only the ones claiming height > current node height
							verification = modules.blocks.verifyBlockHeader(res.body.header);
						} catch (e) {
							library.logger.warn('Failed verifiy block header from', peer.string);
							library.logger.warn("Error", e);
						}


						if(!verification.verified){
							library.logger.warn('# Received invalid block header from peer. Can be a tentative to attack the network!');
							library.logger.warn(peer.string + " sent header",res.body.header);
							library.logger.warn("errors", verification);
							modules.peers.remove(peer.ip, peer.port);

							return cb();
						}
						else{
							library.logger.debug(['Received height:', res.body.header.height, ', block_id: ', res.body.header.id,'from peer'].join(' '), peer.string);
							return cb(null, {peer: peer, height: res.body.header.height, header:res.body.header});
						}
					});
				} else {
					library.logger.warn('Failed to validate peer', peer);
					return cb();
				}
			}, function (err, heights) {
				__private.network = __private.findGoodPeers(heights);

				if (err) {
					return cb(err);
				} else if (!__private.network.peers.length) {
					return cb('Failed to find enough good peers to sync with');
				} else {

					return cb(null, __private.network);
				}
			});
		});
	});
};

//
//__API__ `syncing`

//
Loader.prototype.syncing = function () {
	return !!__private.syncFromNetworkIntervalId;
};

// Events

// The state of blockchain is unclear.
//
//__EVENT__ `onPeersReady`

//
Loader.prototype.onPeersReady = function () {

	// Main loop to observe network state (peers, height, forks etc...)
	// And strategy to sync to winning chain
	setImmediate(function listenToNetwork(){
		if(self.syncing()){
			setTimeout(listenToNetwork, 1000);
			return;
		}
		// Active delegate: poll every 30s
		// Standby delegate: poll every 2min
		// Not active delegate: poll every 5min
		// Maybe special for forging standBy delegates?
		var timeout = 300000;

		if(modules.delegates.isActiveDelegate()){
			timeout = 30000;
		}
		//here, this means standBy delegate ready to forge
		else if(modules.delegates.isForging()){
			timeout = 120000;
		}

		// try to connect to timed out peers and include them in peers if successful
		modules.peers.releaseTimeoutPeers();

		// Triggers a network poll and then comparing to the node state decide if a rebuild should be done.
		self.getNetwork(true,function(err, network){
			// If node is an active delegate we should not be too far from network height, otherwise node might fork for missing consensus.
			var distance = modules.delegates.isActiveDelegate() ? 5 : 60;

			// If node is an active delegate, might be locked in a small fork, unloading only a few blocks.
			var blocksToRemove = modules.delegates.isActiveDelegate() ? 3 : 50;

			// If node is far from observed network height, try some small rebuild
			if(modules.blocks.getLastBlock().height > 1 && __private.blockchainReady && (__private.network.height - modules.blocks.getLastBlock().height > distance)){
				library.logger.info('Late on blockchain height, unloading some blocks to restart synchronisation...');
				self.triggerBlockRemoval(blocksToRemove);
			}
			setTimeout(listenToNetwork, timeout);
		});
	});


	setImmediate(function nextLoadBlock () {
		if(!__private.blockchainReady || self.syncing()){
			return setTimeout(nextLoadBlock, 1000);
		}

		if(__private.forceRemoveBlocks){
			library.logger.info('# Triggered block removal... ');
			modules.blocks.removeSomeBlocks(__private.forceRemoveBlocks, function(err, removedBlocks){
				__private.forceRemoveBlocks=0;
				library.logger.info("1. Removing several blocks to restart synchronisation... Finished");
				library.logger.info("2. Downloading blocks from network...");
				// Update blockchain from network
				__private.syncFromNetwork(function(err){
					if(err){
						library.logger.error("Could not download all blocks from network", err);
					}
					library.logger.info("2. Downloading blocks from network... Finished");
					library.logger.info('# Triggered block removal... Finished');
					setTimeout(nextLoadBlock, 10000);
				});
			});
		}
		else{
			var lastReceipt = modules.blocks.lastReceipt();
			// if we have not received a block for a long time, we think about rebuilding
			if(lastReceipt.rebuild){
				library.logger.info('# Synchronising with network...');
				library.logger.info('Looks like the node has not received a valid block for too long, assessing if a rebuild should be done...');
				library.logger.info('1. polling network...');
				self.getNetwork(true,function(err, network){
					library.logger.info('1. polling network... Finished');

					var distance = modules.delegates.isForging() ? 20 : 50;
					if(modules.delegates.isActiveDelegate()){
						distance = 10;
					}
					//The more we wait without block, the more likely we will rebuild
					distance = distance - (lastReceipt.secondsAgo/20);
					//If we are far behind from observed network height, rebuild
					if(__private.network.height - modules.blocks.getLastBlock().height > distance){
						library.logger.info('Node too behind from network height, rebuild triggered', {networkHeight: __private.network.height, nodeHeight: modules.blocks.getLastBlock().height});
						library.logger.info('2. Removing several blocks to restart synchronisation...');
						var blocksToRemove=10;
						modules.blocks.removeSomeBlocks(blocksToRemove, function(err, removedBlocks){
							library.logger.info("2. Removing several blocks to restart synchronisation... Finished");
							library.logger.info("3. Downloading blocks from network...");
							// Update blockchain from network
							__private.syncFromNetwork(function(err){
								if(err){
									library.logger.error("Could not download all blocks from network", err);
								}
								library.logger.info("3. Downloading blocks from network... Finished");
								library.logger.info('# Synchronising with network... Finished');
								setTimeout(nextLoadBlock, 10000);
							});
						});
					}
					else //If we are far front from observed (majority) network height, rebuild harder
					if(modules.blocks.getLastBlock().height - __private.network.height > 1){
						library.logger.info('Node too front from network majority height, rebuild triggered', {networkHeight: __private.network.height, nodeHeight: modules.blocks.getLastBlock().height});
						library.logger.info('2. Removing several blocks to restart synchronisation...');
						var blocksToRemove=(modules.blocks.getLastBlock().height - __private.network.height)*10;
						modules.blocks.removeSomeBlocks(blocksToRemove, function(err, removedBlocks){
							library.logger.info("2. Removing several blocks to restart synchronisation... Finished");
							library.logger.info("3. Downloading blocks from network...");
							// Update blockchain from network
							__private.syncFromNetwork(function(err){
								if(err){
									library.logger.error("Could not download all blocks from network", err);
								}
								library.logger.info("3. Downloading blocks from network... Finished");
								library.logger.info('# Synchronising with network... Finished');
								setTimeout(nextLoadBlock, 10000);
							});
						});
					}
					else {
						library.logger.info('Node in sync with network, likely some active delegates are missing blocks, rebuild NOT triggered', {networkHeight: __private.network.height, nodeHeight: modules.blocks.getLastBlock().height});
						__private.syncFromNetwork(function (err) {
							if (err) {
								library.logger.warn('Failed to sync from network', err);
							}
							library.logger.info('# Synchronising with network... Finished');
							setTimeout(nextLoadBlock, 10000);
						});
					}
				});
			}

			// we have received a block but it sounds we did get any for over a blocktime, so we try to poll the network to find some
			else if(lastReceipt.stale) {
				library.logger.info('# Synchronising with network...');
				library.logger.info('Not received blocks for over a blocktime');
				__private.syncFromNetwork(function (err) {
					if (err) {
						library.logger.warn('Failed to sync from network', err);
					}
					library.logger.info('# Synchronising with network... Finished');
					setTimeout(nextLoadBlock, modules.delegates.isActiveDelegate()?500:10000);
				});
			}

			//all clear last block was recent enough.
			else {
				setTimeout(nextLoadBlock, 10000);
			}
		}
	});

	setImmediate(function nextLoadUnconfirmedTransactions () {
		if (__private.blockchainReady && !self.syncing()) {
			library.logger.info('# Loading unconfirmed transactions...');
			__private.loadUnconfirmedTransactions(function (err) {
				if (err) {
					library.logger.debug('Unconfirmed transactions timer', err);
				}
				library.logger.info('# Loading unconfirmed transactions... Finished');

				setTimeout(nextLoadUnconfirmedTransactions, 30000);
			});
		} else {
			setTimeout(nextLoadUnconfirmedTransactions, 30000);
		}
	});

	// setImmediate(function nextLoadSignatures () {
	// 	if (__private.blockchainReady && !self.syncing()) {
	// 		library.logger.debug('Loading signatures');
	// 		__private.loadSignatures(function (err) {
	// 			if (err) {
	// 				library.logger.warn('Signatures timer', err);
	// 			}
	//
	// 			setTimeout(nextLoadSignatures, 14000);
	// 		});
	// 	} else {
	// 		setTimeout(nextLoadSignatures, 14000);
	// 	}
	// });
};

// started up
//
//__EVENT__ `onBind`

//
Loader.prototype.onBind = function (scope) {
	modules = scope;
};

//
//__EVENT__ `onLoadDatabase`

//
Loader.prototype.onLoadDatabase = function(){
	__private.loadBlockChain();
};

//
//__EVENT__ `onObserveNetwork`

//
Loader.prototype.onObserveNetwork = function(){
	self.getNetwork(true, function(err, network){
		library.bus.message("networkObserved", network);
	});
};

//
//__EVENT__ `onAttachPublicApi`

//
Loader.prototype.onAttachPublicApi = function () {
 	__private.attachApi();
};

// Blockchain loaded from database and ready to accept blocks from network
//
//__EVENT__ `onDownloadBlocks`

//
Loader.prototype.onDownloadBlocks = function (cb) {

	__private.loadBlocksFromNetwork(cb);
};

// Shutdown asked.
//
//__API__ `cleanup`

//
Loader.prototype.cleanup = function (cb) {
	if (!__private.noShutdownRequired) {
		return setImmediate(cb);
	} else {
		setImmediate(function nextWatch () {
			if (__private.noShutdownRequired) {
				library.logger.info('Waiting for network synchronisation to finish...');
				setTimeout(nextWatch, 1 * 1000);
			} else {
				return setImmediate(cb);
			}
		});
	}
};

// Private
__private.ping = function (cb) {
	var lastBlock = modules.blocks.getLastBlock();

	if (lastBlock && lastBlock.fresh) {
		return setImmediate(cb, 200, {success: true});
	} else {
		return setImmediate(cb, 503, {success: false});
	}
};

// Shared
shared.status = function (req, cb) {
	return setImmediate(cb, null, {
		loaded: __private.blockchainReady,
		now: __private.lastBlock.height,
		blocksCount: __private.total
	});
};

shared.sync = function (req, cb) {
	return setImmediate(cb, null, {
		syncing: self.syncing(),
		blocks: __private.blocksToSync,
		height: modules.blocks.getLastBlock().height,
		id: modules.blocks.getLastBlock().id
	});
};

// Export
module.exports = Loader;
