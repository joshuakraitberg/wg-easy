'use strict';

const fs = require('fs').promises;
const path = require('path');

const debug = require('debug')('WireGuard');
const uuid = require('uuid');
const QRCode = require('qrcode');

const Util = require('./Util');
const ServerError = require('./ServerError');

const {
  WG_PATH,
  WG_IF,
  WG_HOST,
  WG_PORT,
  WG_MTU,
  WG_DEFAULT_DNS,
  WG_DEFAULT_ADDRESS,
  WG_PERSISTENT_KEEPALIVE,
  WG_ALLOWED_IPS,
  WG_PRE_UP,
  WG_POST_UP,
  WG_PRE_DOWN,
  WG_POST_DOWN,
} = require('../config');

module.exports = class WireGuard {

  async getConfig() {
    if (!this.__configPromise) {
      this.__configPromise = Promise.resolve().then(async () => {
        if (!WG_HOST) {
          throw new Error('WG_HOST Environment Variable Not Set!');
        }

        debug('Loading configuration...');
        let config;
        try {
          config = await fs.readFile(path.join(WG_PATH, `${WG_IF}.json`), 'utf8');
          config = JSON.parse(config);
          debug('Configuration loaded.');
        } catch (err) {
          debug('Generating new configuration...');
          const privateKey = await Util.exec('wg genkey');
          const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
            log: 'echo ***hidden*** | wg pubkey',
          });
          const address = WG_DEFAULT_ADDRESS.replace('x', '1');

          config = {
            server: {
              privateKey,
              publicKey,
              address,
            },
            clients: {},
          };
          debug('Configuration generated.');
        }

        await this.__saveConfig(config);
        await this.__restartGateway();
        await this.__syncConfig();

        return config;
      });
    }

    return this.__configPromise;
  }

  async __restartGateway() {
    this.gatewayUp = false;
    debug('Restarting gateway...');
    await Util.exec(`wg-quick down ${WG_IF}`).catch(() => { });
    await Util.exec(`wg-quick up ${WG_IF}`).catch(err => {
      if (err && err.message && err.message.includes(`Cannot find device "${WG_IF}"`)) {
        throw new Error(`WireGuard exited with the error: Cannot find device "${WG_IF}"\nThis usually means that your host\'s kernel does not support WireGuard!`);
      }
      throw err;
    });
    this.gatewayUp = true;
  }

  async saveConfig() {
    const config = await this.getConfig();
    await this.__saveConfig(config);
    await this.__syncConfig();
  }

  async __saveConfig(config) {
    let result = `
# Note: Do not edit this file directly.
# Your changes will be overwritten!

# Server
[Interface]
PrivateKey = ${config.server.privateKey}
Address = ${config.server.address}/24
ListenPort = ${WG_PORT}
PreUp = ${WG_PRE_UP}
PostUp = ${WG_POST_UP}
PreDown = ${WG_PRE_DOWN}
PostDown = ${WG_POST_DOWN}
`;

    for (const [clientId, client] of Object.entries(config.clients)) {
      if (!client.enabled) continue;

      result += `

# Client: ${client.name} (${clientId})
[Peer]
PublicKey = ${client.publicKey}
PresharedKey = ${client.preSharedKey}
AllowedIPs = ${client.address}/32`;
    }

    debug('Config saving...');
    await fs.writeFile(path.join(WG_PATH, `${WG_IF}.json`), JSON.stringify(config, false, 2), {
      mode: 0o660,
    });
    await fs.writeFile(path.join(WG_PATH, `${WG_IF}.conf`), result, {
      mode: 0o600,
    });
    debug('Config saved.');
  }

  async __syncConfig() {
    debug('Config syncing...');
    await Util.exec(`wg syncconf ${WG_IF} <(wg-quick strip ${WG_IF})`);
    debug('Config synced.');
  }

  async getClients() {
    const config = await this.getConfig();
    const clients = Object.entries(config.clients).map(([clientId, client]) => ({
      id: clientId,
      name: client.name,
      enabled: client.enabled,
      address: client.address,
      publicKey: client.publicKey,
      createdAt: new Date(client.createdAt),
      updatedAt: new Date(client.updatedAt),
      allowedIPs: client.allowedIPs,

      persistentKeepalive: null,
      latestHandshakeAt: null,
      transferRx: null,
      transferTx: null,
    }));

    if (!this.gatewayUp) {
      return clients;
    }

    // Loop WireGuard status
    const dump = await Util.exec(`wg show ${WG_IF} dump`, {
      log: false,
    });
    dump
      .trim()
      .split('\n')
      .slice(1)
      .forEach(line => {
        const [
          publicKey,
          preSharedKey, // eslint-disable-line no-unused-vars
          endpoint, // eslint-disable-line no-unused-vars
          allowedIps, // eslint-disable-line no-unused-vars
          latestHandshakeAt,
          transferRx,
          transferTx,
          persistentKeepalive,
        ] = line.split('\t');

        const client = clients.find(client => client.publicKey === publicKey);
        if (!client) return;

        client.latestHandshakeAt = latestHandshakeAt === '0'
          ? null
          : new Date(Number(`${latestHandshakeAt}000`));
        client.transferRx = Number(transferRx);
        client.transferTx = Number(transferTx);
        client.persistentKeepalive = persistentKeepalive;
      });

    return clients;
  }

  async getClient({ clientId }) {
    const config = await this.getConfig();
    const client = config.clients[clientId];
    if (!client) {
      throw new ServerError(`Client Not Found: ${clientId}`, 404);
    }

    return client;
  }

  async getClientConfiguration({ clientId }) {
    // Keys of client are regenerated on each call!
    // Gateway must be restarted to update to new keys

    const config = await this.getConfig();
    const client = await this.getClient({ clientId });

    // Generate new client keys
    debug(`Client config requested: ${client.name} / ${clientId}`);
    const privateKey = await Util.exec('wg genkey');
    client.privateKey = null;
    client.publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
      log: 'echo ***hidden*** | wg pubkey',
    });
    client.preSharedKey = await Util.exec('wg genpsk');

    // Restart gateway to complete key regen
    await this.saveConfig();

    return `
[Interface]
PrivateKey = ${privateKey}
Address = ${client.address}/24
${WG_DEFAULT_DNS ? `DNS = ${WG_DEFAULT_DNS}` : ''}
${WG_MTU ? `MTU = ${WG_MTU}` : ''}

[Peer]
PublicKey = ${config.server.publicKey}
PresharedKey = ${client.preSharedKey}
AllowedIPs = ${WG_ALLOWED_IPS}
PersistentKeepalive = ${WG_PERSISTENT_KEEPALIVE}
Endpoint = ${WG_HOST}:${WG_PORT}`;
  }

  async getClientQRCodeSVG({ clientId }) {
    const config = await this.getClientConfiguration({ clientId });
    return QRCode.toString(config, {
      type: 'svg',
      width: 512,
    });
  }

  async createClient({ name }) {
    if (!name) {
      throw new Error('Missing: Name');
    }

    debug(`Creating new client: ${name}`);
    const config = await this.getConfig();
    const privateKey = await Util.exec('wg genkey');
    const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
      log: 'echo ***hidden*** | wg pubkey',
    });
    const preSharedKey = await Util.exec('wg genpsk');

    // Calculate next IP
    let address;
    for (let i = 2; i < 255; i++) {
      const client = Object.values(config.clients).find(client => {
        return client.address === WG_DEFAULT_ADDRESS.replace('x', i);
      });

      if (!client) {
        address = WG_DEFAULT_ADDRESS.replace('x', i);
        break;
      }
    }

    if (!address) {
      throw new Error('Maximum number of clients reached.');
    }

    // Create Client
    const clientId = uuid.v4();
    const client = {
      name,
      address,
      privateKey: null,
      publicKey,
      preSharedKey,
      createdAt: new Date(),
      updatedAt: new Date(),
      enabled: true,
    };

    config.clients[clientId] = client;

    await this.saveConfig();
  }

  async deleteClient({ clientId }) {
    const config = await this.getConfig();
    const client = config.clients[clientId];

    if (client) {
      debug(`Deleting client:  ${client.name} / ${clientId}`);
      delete config.clients[clientId];
      await this.saveConfig();
    }
  }

  async enableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    debug(`Enabling client: ${client.name} / ${clientId}`);
    client.enabled = true;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async disableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    debug(`Disabling client: ${client.name} / ${clientId}`);
    client.enabled = false;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientName({ clientId, name }) {
    const client = await this.getClient({ clientId });

    debug(`Upading client name: ${name} / ${clientId}`);
    client.name = name;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientAddress({ clientId, address }) {
    const client = await this.getClient({ clientId });

    if (!Util.isValidIPv4(address)) {
      throw new ServerError(`Invalid Address: ${address}`, 400);
    }

    debug(`Updating client address: ${client.name} / ${clientId}`);
    client.address = address;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

};
