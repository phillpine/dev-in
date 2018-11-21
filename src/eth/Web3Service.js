import PrivateService from '../core/PrivateService';
import { promisify, promisifyMethods, getNetworkName } from '../utils';
import Web3ServiceList from '../utils/Web3ServiceList';
import promiseProps from 'promise-props';
import Web3 from 'web3';

const TIMER_CONNECTION = 'web3CheckConnectionStatus';
const TIMER_AUTHENTICATION = 'web3CheckAuthenticationStatus';
const TIMER_DEFAULT_DELAY = 5000;

export default class Web3Service extends PrivateService {
  constructor(name = 'web3') {
    super(name, ['accounts', 'log', 'timer', 'cache', 'event']);

    this._web3 = null;
    this._ethersProvider = null;
    this._blockListeners = {};
    this._currentBlock = null;
    this._info = {};
    this._statusTimerDelay = TIMER_DEFAULT_DELAY;
    this._defaultEmitter = null;
    this._transactionSettings = null;
    this._blockSub = null;
    this._eventSub = null;
    this._interval = null;
    Web3ServiceList.push(this);
  }

  info() {
    return this._info;
  }

  networkId() {
    const result = this.info().network;
    if (!result) {
      throw new Error('Cannot resolve network ID. Are you connected?');
    }
    return parseInt(result);
  }

  currentAccount() {
    return this.get('accounts').currentAddress();
  }

  ethersProvider() {
    // STOP USING THIS
    try {
      throw new Error('hi');
    } catch (err) {
      // console.warn(
      //   'using ethers provider...\n' +
      //     err.stack
      //       .split('\n')
      //       .slice(1, 8)
      //       .join('\n')
      // );
    }
    return this._ethersProvider;
  }

  getEthersSigner() {
    if (this.usingWebsockets()) {
      if (!this._ethersSigner) {
        const provider = this.web3Provider();
        const call = promisify(this._web3.eth.call);
        this._ethersSigner = {
          getAddress: () => this.currentAccount(),
          estimateGas: tx => this.estimateGas(tx),
          sendTransaction: tx => {
            return this.sendTransaction({
              ...tx,
              from: this.currentAccount()
            });
          },
          provider: new Proxy(provider, {
            get(target, key) {
              switch (key) {
                case 'resolveName':
                  return address => address;
                case 'call':
                  return call;
                default:
                  return target[key];
              }
            }
          })
        };
      }
      return this._ethersSigner;
    } else {
      return this.ethersProvider().getSigner();
    }
  }

  web3Provider() {
    return this._web3.currentProvider;
  }

  transactionSettings() {
    return this._transactionSettings;
  }

  usingWebsockets() {
    return this._serviceManager._settings.provider.type === 'WS';
  }

  confirmedBlockCount() {
    return this._confirmedBlockCount;
  }

  web3Contract(abi, address) {
    return new this._web3.eth.Contract(abi, address);
  }

  subscribeNewBlocks(cb) {
    this._blockSub = this._web3.eth
      .subscribe('newBlockHeaders')
      .on('data', blockHeader => {
        cb(blockHeader);
      });
  }

  unsubscribeNewBlocks() {
    this._blockSub.unsubscribe((err, success) => {
      if (!success) throw new Error(err);
      this.get('log').info('Web3 unsubscribing from newBlockHeaders...');
    });
  }

  subscribeLog(info, event) {
    const { address, abi } = info;
    const res = abi.reduce(
      (acc, target) => ({
        ...acc,
        [target.name]: target
      }),
      {}
    );

    const getTopics = () => {
      const { sha3 } = this._web3.utils;
      let topics = [];
      let name = res[event].name + '(';
      for (let i in res[event].inputs) {
        name += res[event].inputs[i].type + ',';
      }
      topics[0] = sha3(name.substring(0, name.length - 1) + ')');
      return topics;
    };
    return new Promise((resolve, reject) => {
      this._eventSub = this._web3.eth.subscribe(
        'logs',
        { address, topics: getTopics() },
        (err, log) => {
          if (err) reject(err);
          if (!res[event].anonymous) {
            log.topics.shift();
          }
          const decoded = this._web3.eth.abi.decodeLog(
            res[event].inputs,
            log.data,
            log.topics
          );
          resolve(this.unsubscribeEvent(decoded));
        }
      );
    });
  }

  unsubscribeEvent(log) {
    this._eventSub.unsubscribe((err, success) => {
      if (!success) throw new Error(err);
    });
    return log;
  }

  async initialize(settings) {
    this.get('log').info('Web3 is initializing...');
    this._defaultEmitter = this.get('event');

    this._web3 = new Web3();
    this._web3.setProvider(this.get('accounts').getProvider());

    Object.assign(
      this,
      promisifyMethods(this._web3.eth, [
        'estimateGas',
        'getBalance',
        'getBlock',
        'getTransaction',
        'getTransactionReceipt',
        'sendTransaction'
      ]),
      {
        getAccounts: () =>
          this.get('accounts')
            .listAccounts()
            .map(account => {
              return account.address;
            }),
        subscribe: (...args) => this._web3.eth.subscribe(...args)
      }
    );

    this._setStatusTimerDelay(settings.statusTimerDelay);
    this._installCleanUpHooks();
    this._defaultEmitter.emit('web3/INITIALIZED', {
      provider: { ...settings.provider }
    });
    this._transactionSettings = settings.transactionSettings;
    this._confirmedBlockCount = settings.confirmedBlockCount || 5;
  }

  async connect() {
    this.get('log').info('Web3 is connecting...');

    this._info = await promiseProps({
      api: this._web3.version,
      node: promisify(this._web3.eth.getNodeInfo)(),
      network: promisify(this._web3.eth.net.getId)(),
      ethereum: promisify(this._web3.eth.getProtocolVersion)()
    });

    if (!this._info.node.includes('MetaMask')) {
      this._info.whisper = this._web3.shh;
    }

    // FIXME set up block listening with web3 instead
    this._setUpEthers(this.networkId());

    this._listenBlocks();
    this._installDisconnectCheck();
    await this._initEventPolling();
    this._defaultEmitter.emit('web3/CONNECTED', {
      ...this._info
    });
    this.get('log').info('Web3 version: ', this._info.api);
  }

  async authenticate() {
    this.get('log').info('Web3 is authenticating...');

    this._defaultEmitter.emit('web3/AUTHENTICATED', {
      account: this.currentAccount()
    });
    this._installDeauthenticationCheck();
  }

  getNetwork() {
    return this._info.network;
  }

  blockNumber() {
    return this._currentBlock;
  }

  _listenBlocks() {
    if (this.usingWebsockets()) {
      this.subscribeNewBlocks(data => {
        this._updateBlockNumber(data.number);
      });
    } else {
      this._interval = setInterval(async () => {
        const blockNumber = await this._web3.eth.getBlockNumber();
        if (this._currentBlock < blockNumber) {
          for (let i = this._currentBlock; i < blockNumber; i++) {
            this._updateBlockNumber(i);
            this._currentBlock++;
          }
        }
      }, 100);
    }
  }

  onNewBlock(callback) {
    if (!this._blockListeners['*']) {
      this._blockListeners['*'] = [];
    }

    this._blockListeners['*'].push(callback);
  }

  async waitForBlockNumber(blockNumber) {
    if (blockNumber < this._currentBlock) {
      console.error('Attempted to wait for past block ' + blockNumber);
      return;
    }

    if (blockNumber === this._currentBlock) {
      return Promise.resolve(blockNumber);
    }

    if (!this._blockListeners[blockNumber]) {
      this._blockListeners[blockNumber] = [];
    }

    return new Promise(resolve => {
      this._blockListeners[blockNumber].push(resolve);
    });
  }

  _updateBlockNumber(blockNumber) {
    this.get('log').info('New block:', blockNumber);
    this._currentBlock = blockNumber;

    if (this._blockListeners[blockNumber]) {
      this._blockListeners[blockNumber].forEach(c => c(blockNumber));
      this._blockListeners[blockNumber] = undefined;
    }

    if (this._blockListeners['*']) {
      this._blockListeners['*'].forEach(c => c(blockNumber));
    }
  }

  _initEventPolling() {
    this.onNewBlock(this.get('event').ping);
  }

  _removeBlockUpdates() {
    if (this.usingWebsockets()) {
      this.unsubscribeNewBlocks();
    } else {
      // clearInterval(this._interval);
    }
  }
  _installCleanUpHooks() {
    this.manager().onDisconnected(() => {
      this._removeBlockUpdates();
      this.get('timer').disposeTimer(TIMER_CONNECTION);
    });

    this.manager().onDeauthenticated(() => {
      this._removeBlockUpdates();
      this.get('timer').disposeTimer(TIMER_AUTHENTICATION);
    });
  }

  _setUpEthers(chainId) {
    const ethers = require('ethers');
    this._ethersProvider = this._buildEthersProvider(ethers, chainId);
  }

  _buildEthersProvider(ethers, chainId) {
    const provider = new ethers.providers.Web3Provider(
      this._web3.currentProvider,
      { name: getNetworkName(chainId), chainId: chainId }
    );

    return provider;
  }

  _setStatusTimerDelay(delay) {
    this._statusTimerDelay = delay ? parseInt(delay) : TIMER_DEFAULT_DELAY;
  }

  _installDisconnectCheck() {
    this.get('timer').createTimer(
      TIMER_CONNECTION,
      this._statusTimerDelay,
      true,
      () =>
        this._isStillConnected().then(connected => {
          if (!connected) {
            this._defaultEmitter.emit('web3/DISCONNECTED');
            this.disconnect();
          }
        })
    );
  }

  _isStillConnected() {
    // only determine network change as disconnect if service is connected
    if (!this.manager().isConnected()) {
      return false;
    }
    return promisify(this._web3.eth.net.getId)()
      .then(network => network === this._info['network'])
      .catch(() => false);
  }

  _installDeauthenticationCheck() {
    this.get('timer').createTimer(
      TIMER_AUTHENTICATION,
      this._statusTimerDelay, //what should this number be?
      true,
      () =>
        this._isStillAuthenticated().then(authenticated => {
          if (!authenticated) {
            this._defaultEmitter.emit('web3/DEAUTHENTICATED');
            this.deauthenticate();
          }
        })
    );
  }

  async _isStillAuthenticated() {
    if (this.get('accounts').hasNonProviderAccount())
      return this._isStillConnected();
    const account = (await promisify(this._web3.eth.getAccounts)())[0];
    return account === this.currentAccount();
  }
}
