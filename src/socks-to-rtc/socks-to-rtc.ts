/*
  SocksToRTC.Peer passes socks requests over WebRTC datachannels.
*/
/// <reference path='socks.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/freedom.d.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/transport.d.ts' />
/// <reference path='../common/arraybuffers.ts' />
/// <reference path='../interfaces/communications.d.ts' />

// TODO replace with a reference to freedom ts interface once it exists.
console.log('WEBWORKER SocksToRtc: ' + self.location.href);

module SocksToRTC {

  var fCore = freedom.core();

  /**
   * SocksToRTC.Peer
   *
   * Contains a local SOCKS server which passes requests remotely through
   * WebRTC peer connections.
   */
  export class Peer {

    private socksServer_:Socks.Server = null;  // Local SOCKS server.
    private signallingChannel_:any = null;     // NAT piercing route.
    private transport_:freedom.Transport = null;     // For actual proxying.

    // Active SOCKS sessions, by datachannel tag name.
    private socksSessions_:{[tag:string]:Socks.Session} = {};
    private peerId_:string = null;         // Of the remote rtc-to-net peer.

    // Connection callbacks, by datachannel tag name.
    // TODO: figure out a more elegant way to store these callbacks
    private static connectCallbacks:{[tag:string]:(response:Channel.NetConnectResponse) => void} = {};

    /**
     * Start the Peer, based on the remote peer's info.
     */
    public start = (remotePeer:PeerInfo) => {
      this.reset();  // Begin with fresh components.
      dbg('starting - target peer: ' + JSON.stringify(remotePeer));
      // Bind peerID to scope so promise can work.
      var peerId = this.peerId_ = remotePeer.peerId;
      if (!peerId) {
        dbgErr('no Peer ID provided! cannot connect.');
        return false;
      }
      // SOCKS sessions biject to peerconnection datachannels.
      this.transport_ = freedom['transport']();
      this.transport_.on('onData', this.onDataFromPeer_);
      this.transport_.on('onClose', this.closeConnectionToPeer);
      // Messages received via signalling channel must reach the remote peer
      // through something other than the peerconnection. (e.g. XMPP)
      fCore.createChannel().then((chan) => {
        this.transport_.setup('SocksToRtc-' + peerId, chan.identifier);
        this.signallingChannel_ = chan.channel;
        this.signallingChannel_.on('message', function(msg) {
          freedom.emit('sendSignalToPeer', {
              peerId: peerId,
              data: msg
          });
        });
        dbg('signalling channel to SCTP peer connection ready.');
      });  // fCore.createChannel

      // Create SOCKS server and start listening.
      this.socksServer_ = new Socks.Server(remotePeer.host, remotePeer.port,
                                          this.onConnection_);
      this.socksServer_.listen();
    }

    /**
     * Stop SOCKS server and close data channels and peer connections.
     */
    public reset = () => {
      dbg('resetting peer...');
      if (this.socksServer_) {
        this.socksServer_.disconnect();  // Disconnects internal TCP server.
        this.socksServer_ = null;
      }
      for (var tag in this.socksSessions_) {
        this.closeConnectionToPeer(tag);
      }
      this.socksSessions_ = {};
      if(this.transport_) {
        this.transport_.close();
        this.transport_ = null;
      }
      if (this.signallingChannel_) {  // TODO: is this actually right?
        this.signallingChannel_.emit('close');
      }
      this.signallingChannel_ = null;
      this.peerId_ = null;
    }

    /**
     * Setup new data channel and tie to corresponding SOCKS5 session.
     * Returns: IP and port of destination.
     */
    private onConnection_ = (session:Socks.Session, address, port, protocol)
        :Promise<Channel.EndpointInfo> => {
      // We don't have a way to pipe UDP traffic through the datachannel
      // just yet so, for now, just exit early in the UDP case.
      // TODO(yangoon): pipe UDP traffic through the datachannel
      // TODO(yangoon): serious refactoring needed here!
      if (protocol == 'udp') {
        return Promise.resolve({ ipAddrString: '127.0.0.1', port: 0 });
      }

      if (!this.transport_) {
        dbgWarn('transport_ not ready');
        return;
      }

      // Generate a name for this connection and associate it with the SOCKS session.
      var tag = obtainTag();
      this.tieSessionToChannel_(session, tag);

      // This gets a little funky: ask the peer to establish a connection to
      // the remote host and register a callback for when it gets back to us
      // on the control channel.
      // TODO: how to add a timeout, in case the remote end never replies?
      return new Promise((F,R) => {
        Peer.connectCallbacks[tag] = (response:Channel.NetConnectResponse) => {
          if (response.address) {
            F({
              ipAddrString: response.address,
              port: response.port
            });
          } else {
            R(new Error('could not create datachannel'));
          }
        }
        var request:Channel.NetConnectRequest = {
          protocol: 'tcp',
          address: address,
          port: port
        };
        var command:Channel.Command = {
            type: Channel.COMMANDS.NET_CONNECT_REQUEST,
            tag: tag,
            data: JSON.stringify(request)
        };
        this.transport_.send('control', ArrayBuffers.stringToArrayBuffer(
            JSON.stringify(command)));
      });
    }

    /**
     * Create one-to-one relationship between a SOCKS session and a datachannel.
     */
    private tieSessionToChannel_ = (session:Socks.Session, tag:string) => {
      this.socksSessions_[tag] = session;
      // When the TCP-connection receives data, send to sctp peer.
      // When it disconnects, clear the |tag|.
      session.onRecv((buf) => { this.sendToPeer_(tag, buf); });
      session.onceDisconnected().then(() => {
        var command:Channel.Command = {
            type: Channel.COMMANDS.SOCKS_DISCONNECTED,
            tag: tag
        };
        this.transport_.send('control', ArrayBuffers.stringToArrayBuffer(
            JSON.stringify(command)));
      });
    }

    /**
     * Receive replies proxied back from the remote RtcToNet.Peer and pass them
     * back across underlying SOCKS session / TCP socket.
     */
    private onDataFromPeer_ = (msg:freedom.Transport.IncomingMessage) => {
      dbg(msg.tag + ' <--- received ' + msg.data.byteLength);
      if (!msg.tag) {
        dbgErr('received message without datachannel tag!: ' + JSON.stringify(msg));
        return;
      }

      if (msg.tag == 'control') {
        var command:Channel.Command = JSON.parse(
            ArrayBuffers.arrayBufferToString(msg.data));

        if (command.type === Channel.COMMANDS.NET_CONNECT_RESPONSE) {
          // Call the associated callback and forget about it.
          // The callback should fulfill or reject the promise on
          // which the client is waiting, completing the connection flow.
          var response:Channel.NetConnectResponse = JSON.parse(command.data);
          if (command.tag in Peer.connectCallbacks) {
            var callback = Peer.connectCallbacks[command.tag];
            callback(response);
            Peer.connectCallbacks[command.tag] = undefined;
          } else {
            dbgWarn('received connect callback for unknown datachannel: ' +
                command.tag);
          }
        } else if (command.type === Channel.COMMANDS.NET_DISCONNECTED) {
          // Receiving a disconnect on the remote peer should close SOCKS.
          dbg(command.tag + ' <--- received NET-DISCONNECTED');
          this.closeConnectionToPeer(command.tag);
        } else {
          dbgWarn('unsupported control command: ' + command.type);
        }
      } else {
        if (!(msg.tag in this.socksSessions_)) {
          dbgErr('unknown datachannel ' + msg.tag);
          return;
        }
        var session = this.socksSessions_[msg.tag];
        session.sendData(msg.data);
      }
    }

    /**
     * Close a particular SOCKS session.
     */
    private closeConnectionToPeer = (tag:string) => {
      dbg('datachannel ' + tag + ' has closed. ending SOCKS session for channel.');
      this.socksServer_.endSession(this.socksSessions_[tag]);
      delete this.socksSessions_[tag];
    }

    /**
     * Send data over SCTP to peer, via data channel |tag|.
     *
     * Side note: When transport_ encounters a 'new' |tag|, it
     * implicitly creates a new data channel.
     */
    private sendToPeer_ = (tag:string, buffer:ArrayBuffer) => {
      if (!this.transport_) {
        dbgWarn('transport_ not ready');
        return;
      }
      dbg('send ' + buffer.byteLength + ' bytes on datachannel ' + tag);
      this.transport_.send(tag, buffer);
    }

    /**
     * Pass any messages coming from remote peer through the signalling channel
     * handled by freedom, which goes to the signalling channel input of the
     * peer connection.
     */
    public handlePeerSignal = (msg:PeerSignal) => {
      // dbg('client handleSignalFromPeer: ' + JSON.stringify(msg) +
                  // ' with state ' + this.toString());
      if (!this.signallingChannel_) {
        dbgErr('signalling channel missing!');
        return;
      }
      this.signallingChannel_.emit('message', msg.data);
    }

    public toString = () => {
      var ret ='<SocksToRTC.Peer: failed toString()>';
      try {
        ret = JSON.stringify({ socksServer: this.socksServer_,
                               transport: this.transport_,
                               peerId: this.peerId_,
                               signallingChannel: this.signallingChannel_,
                               socksSessions: this.socksSessions_ });
      } catch (e) {}
      return ret;
    }

  }  // SocksToRTC.Peer

  // TODO: reuse tag names from a pool.
  function obtainTag() {
    return 'c' + Math.random();
  }

  var modulePrefix_ = '[SocksToRtc] ';
  function dbg(msg:string) { console.log(modulePrefix_ + msg); }
  function dbgWarn(msg:string) { console.warn(modulePrefix_ + msg); }
  function dbgErr(msg:string) { console.error(modulePrefix_ + msg); }

}  // module SocksToRTC


function initClient() {

  // Create local peer and attach freedom message handlers, then emit |ready|.
  var peer = new SocksToRTC.Peer();
  freedom.on('handleSignalFromPeer', peer.handlePeerSignal);
  freedom.on('start', peer.start);
  freedom.on('stop', peer.reset);
  freedom.emit('ready', {});
}


initClient();
