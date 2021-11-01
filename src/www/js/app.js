/* eslint-disable no-console */
/* eslint-disable no-alert */
/* eslint-disable no-undef */
/* eslint-disable no-new */

'use strict';

new Vue({
  el: '#app',
  data: {
    authenticated: null,
    authenticating: false,
    password: null,
    requiresPassword: null,

    clients: null,
    clientDelete: null,
    clientCreate: null,
    clientQRShow: null,
    clientConfigDownload: null,
    clientCreateName: '',
    clientCreateAllowedIPs: '',
    clientCreateAllowedIPsDefault: '0.0.0.0/0, ::0/0',
    clientCreateAllowedIPsExclude: (
      '::/0, 1.0.0.0/8, 2.0.0.0/8, 3.0.0.0/8, '
      + '4.0.0.0/6, 8.0.0.0/7, 11.0.0.0/8, 12.0.0.0/6, '
      + '16.0.0.0/4, 32.0.0.0/3, 64.0.0.0/2, 128.0.0.0/3, '
      + '160.0.0.0/5, 168.0.0.0/6, 172.0.0.0/12, 172.32.0.0/11, '
      + '172.64.0.0/10, 172.128.0.0/9, 173.0.0.0/8, 174.0.0.0/7, '
      + '176.0.0.0/4, 192.0.0.0/9, 192.128.0.0/11, 192.160.0.0/13, '
      + '192.169.0.0/16, 192.170.0.0/15, 192.172.0.0/14, 192.176.0.0/12, '
      + '192.192.0.0/10, 193.0.0.0/8, 194.0.0.0/7, 196.0.0.0/6, '
      + '200.0.0.0/5, 208.0.0.0/4'
    ),
    clientEditName: null,
    clientEditNameId: null,
    clientEditAddress: null,
    clientEditAddressId: null,
    qrcode: null,

    currentRelease: null,
    latestRelease: null,
  },
  methods: {
    dateTime: value => {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }).format(value);
    },
    async refresh() {
      if (!this.authenticated) return;

      const clients = await this.api.getClients();
      this.clients = clients.map(client => {
        if (client.name.includes('@') && client.name.includes('.')) {
          client.avatar = `https://www.gravatar.com/avatar/${md5(client.name)}?d=blank`;
        }

        return client;
      });

      console.log(clients);
    },
    login(e) {
      e.preventDefault();

      if (!this.password) return;
      if (this.authenticating) return;

      this.authenticating = true;
      this.api.createSession({
        password: this.password,
      })
        .then(async () => {
          const session = await this.api.getSession();
          this.authenticated = session.authenticated;
          this.requiresPassword = session.requiresPassword;
          return this.refresh();
        })
        .catch(err => {
          alert(err.message || err.toString());
        })
        .finally(() => {
          this.authenticating = false;
        });
    },
    logout(e) {
      e.preventDefault();

      this.api.deleteSession()
        .then(() => {
          this.authenticated = false;
          this.clients = null;
        })
        .catch(err => {
          alert(err.message || err.toString());
        });
    },
    areClientsHardened() {
      return this.api.areClientsHardened();
    },
    getDns() {
      return this.api.getDns();
    },
    createClient() {
      const name = this.clientCreateName;
      const allowedIPs = this.clientCreateAllowedIPs;
      if (!name) return;
      if (!allowedIPs) return;

      this.api.createClient({ name, allowedIPs })
        .catch(err => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    deleteClient(client) {
      this.api.deleteClient({ clientId: client.id })
        .catch(err => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    enableClient(client) {
      this.api.enableClient({ clientId: client.id })
        .catch(err => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    disableClient(client) {
      this.api.disableClient({ clientId: client.id })
        .catch(err => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientName(client, name) {
      this.api.updateClientName({ clientId: client.id, name })
        .catch(err => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
    updateClientAddress(client, address) {
      this.api.updateClientAddress({ clientId: client.id, address })
        .catch(err => alert(err.message || err.toString()))
        .finally(() => this.refresh().catch(console.error));
    },
  },
  filters: {
    timeago: value => {
      return timeago().format(value);
    },
    bytes: (bytes, decimals, kib, maxunit) => {
      kib = kib || false;
      if (bytes === 0) return '0 Bytes';
      if (Number.isNaN(parseFloat(bytes)) && !Number.isFinite(bytes)) return 'Not an number';
      const k = kib ? 1024 : 1000;
      const dm = decimals != null && !Number.isNaN(decimals) && decimals >= 0 ? decimals : 2;
      const sizes = kib
        ? ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB', 'BiB']
        : ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB', 'BB'];
      let i = Math.floor(Math.log(bytes) / Math.log(k));
      if (maxunit !== undefined) {
        const index = sizes.indexOf(maxunit);
        if (index !== -1) i = index;
      }
      // eslint-disable-next-line no-restricted-properties
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    },
  },
  mounted() {
    this.api = new API();
    this.api.getSession()
      .then(session => {
        this.authenticated = session.authenticated;
        this.requiresPassword = session.requiresPassword;
        this.refresh().catch(err => {
          alert(err.message || err.toString());
        });
      })
      .catch(err => {
        alert(err.message || err.toString());
      });

    setInterval(() => {
      this.refresh().catch(console.error);
    }, 1000);

    Promise.resolve().then(async () => {
      const currentRelease = await this.api.getRelease();
      const latestRelease = await fetch('https://weejewel.github.io/wg-easy/changelog.json')
        .then(res => res.json())
        .then(releases => {
          const releasesArray = Object.entries(releases).map(([version, changelog]) => ({
            version: parseInt(version, 10),
            changelog,
          }));
          releasesArray.sort((a, b) => {
            return b.version - a.version;
          });

          return releasesArray[0];
        });

      console.log(`Current Release: ${currentRelease}`);
      console.log(`Latest Release: ${latestRelease.version}`);

      if (currentRelease >= latestRelease.version) return;

      this.currentRelease = currentRelease;
      this.latestRelease = latestRelease;
    }).catch(console.error);
  },
});
