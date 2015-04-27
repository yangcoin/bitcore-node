'use strict';

var util = require('util');
var EventEmitter = require('eventemitter2').EventEmitter2;

var bitcore = require('bitcore');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Promise = require('bluebird');
var RPC = require('bitcoind-rpc');

var NetworkMonitor = require('./networkmonitor');
var EventBus = require('./eventbus');

var LevelUp = require('levelup');
var BlockService = require('./services/block');
var TransactionService = require('./services/transaction');
var AddressService = require('./services/address');

var BlockChain = require('./blockchain');
var genesisBlocks = require('./data/genesis');

var BitcoreNode = function(bus, networkMonitor, blockService, transactionService, addressService) {
  $.checkArgument(bus, 'bus is required');
  $.checkArgument(networkMonitor, 'networkMonitor is required');
  $.checkArgument(blockService, 'blockService is required');
  $.checkArgument(transactionService, 'transactionService is required');
  $.checkArgument(addressService, 'addressService is required');
  this.bus = bus;
  this.networkMonitor = networkMonitor;

  this.tip = null;

  this.addressService = addressService;
  this.transactionService = transactionService;
  this.blockService = blockService;

  this.blockCache = {};
  this.inventory = {}; // blockHash -> bool (has data)
  this.initialize();
};
util.inherits(BitcoreNode, EventEmitter);

BitcoreNode.create = function(opts) {
  opts = opts || {};

  var bus = new EventBus();

  var networkMonitor = NetworkMonitor.create(bus, opts.NetworkMonitor);

  var database = opts.database || Promise.promisifyAll(
    new LevelUp(opts.LevelUp || './db')
  );
  var rpc = opts.rpc || Promise.promisifyAll(new RPC(opts.RPC));

  var transactionService = opts.transactionService || new TransactionService({
    rpc: rpc,
    database: database
  });
  var blockService = opts.blockService || new BlockService({
    rpc: rpc,
    database: database,
    transactionService: transactionService
  });
  var addressService = opts.addressService || new AddressService({
    rpc: rpc,
    database: database,
    transactionService: transactionService,
    blockService: blockService
  });
  return new BitcoreNode(bus, networkMonitor, blockService, transactionService, addressService);
};


BitcoreNode.prototype.initialize = function() {
  var self = this;


  var prevHeight = 0;
  var statTimer = 5 * 1000;
  setInterval(function() {
    if (!self.blockchain) {
      // not ready yet
      return;
    }
    var tipHash = self.blockchain.tip;
    var block = self.blockCache[tipHash];
    var delta = block.height - prevHeight;
    prevHeight = block.height;
    console.log(block.id, block.height, 'vel', delta * 1000 / statTimer, 'b/s');
  }, statTimer);

  this.bus.register(bitcore.Block, function(block) {

    var prevHash = bitcore.util.buffer.reverse(block.header.prevHash).toString('hex');
    self.blockCache[block.hash] = block;
    self.inventory[block.hash] = true;
    if (!self.blockchain.hasData(prevHash)) {
      self.requestFromTip();
      return;
    }
    var blockchainChanges = self.blockchain.proposeNewBlock(block);

    // Annotate block with extra data from the chain
    block.height = self.blockchain.height[block.id];
    block.work = self.blockchain.work[block.id];

    //console.log('block', block.id, block.height);

    return Promise.each(blockchainChanges.unconfirmed, function(hash) {
        return self.blockService.unconfirm(self.blockCache[hash]);
      })
      .then(function() {
        return Promise.all(blockchainChanges.confirmed.map(function(hash) {
          return self.blockService.confirm(self.blockCache[hash]);
        }));
      })
      .then(function() {
        var deleteHeight = block.height - 100;
        if (deleteHeight > 0) {
          var deleteHash = self.blockchain.hashByHeight[deleteHeight];
          delete self.blockCache[deleteHash];
        }
      })
      .then(function() {
        // TODO: include this
        if (false && _.size(self.inventory) && _.all(_.values(self.inventory))) {
          self.inventory = {};
          self.requestFromTip();
        }
      })
      .catch(function(error) {
        self.stop(error);
      });
  });

  this.bus.onAny(function(value) {
    self.emit(this.event, value);
  });
  this.networkMonitor.on('error', function(err) {
    self.emit('error', err);
  });
  this.networkMonitor.on('disconnect', function() {
    console.log('network monitor disconnected');
  });
};

BitcoreNode.prototype.start = function() {
  var self = this;
  var genesis = bitcore.Block.fromBuffer(genesisBlocks[bitcore.Networks.defaultNetwork.name]);

  this.blockService.getBlockchain().then(function(blockchain) {
    if (!blockchain) {
      self.blockchain = new BlockChain();
      self.bus.process(genesis);
    } else {
      self.blockchain = blockchain;
    }
    self.sync();
    self.networkMonitor.start();
  });
  this.networkMonitor.on('stop', function() {
    self.blockService.saveBlockchain(self.blockchain);
  });
};

BitcoreNode.prototype.stop = function(reason) {
  this.networkMonitor.abort(reason);
};

BitcoreNode.prototype.requestFromTip = function() {
  var locator = this.blockchain.getBlockLocator();
  console.log('requesting blocks, locator size:', locator.length);
  this.networkMonitor.requestBlocks(locator);
};

BitcoreNode.prototype.sync = function() {
  var self = this;
  this.networkMonitor.on('ready', function() {
    self.requestFromTip();
  });
};

module.exports = BitcoreNode;