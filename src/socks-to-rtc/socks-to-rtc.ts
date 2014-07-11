/*
  SocksToRTC.Peer passes socks requests over WebRTC datachannels.
*/
/// <reference path='socks.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/freedom.d.ts' />
/// <reference path='../../node_modules/freedom-typescript-api/interfaces/peer-connection.d.ts' />
/// <reference path='../../node_modules/uproxy-build-tools/src/util/arraybuffers.d.ts' />
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
    private pc_:freedom.PeerConnection = null; // For actual proxying.

    /**
     * Currently open data channels, indexed by data channel tag name.
     */
    private channels_:{[tag:string]:Channel.EndpointInfo} = {};
    private peerId_:string = null;         // Of the remote rtc-to-net peer.
    private remotePeer_:PeerInfo = null;

    // Private state kept for ping-pong (heartbeat and ack).
    private pingPongSendIntervalId_ :number = null;
    private pingPongCheckIntervalId_ :number = null;
    private lastPingPongReceiveDate_ :Date = null;

    // Connection callbacks, by datachannel tag name.
    // TODO: figure out a more elegant way to store these callbacks
    private static connectCallbacks:{[tag:string]:(response:Channel.NetConnectResponse) => void} = {};

    /**
     * Start the Peer, based on the remote peer's info.
     * This will emit a socksToRtcSuccess signal when the peer connection is esablished,
     * or a socksToRtcFailure signal if there is an error openeing the peer connection.
     * TODO: update this to return a promise that fulfills/rejects, after freedom v0.5
     * is ready.
     */
    public start = (remotePeer:PeerInfo) => {
      this.reset_();  // Begin with fresh components.
      dbg('starting - target peer: ' + JSON.stringify(remotePeer));
      // Bind peerID to scope so promise can work.
      this.remotePeer_ = remotePeer;
      var peerId = this.peerId_ = remotePeer.peerId;
      if (!peerId) {
        dbgErr('no Peer ID provided! cannot connect.');
        return false;
      }
      // SOCKS sessions biject to peerconnection datachannels.
      this.pc_ = freedom['core.peerconnection']();
      this.pc_.on('onReceived', this.onDataFromPeer_);
      this.pc_.on('onClose', this.onCloseHandler_);

      // Messages received via signalling channel must reach the remote peer
      // through something other than the peerconnection. (e.g. XMPP)
      fCore.createChannel().then((chan) => {
        // TODO: Stolen from transport provider.
        var STUN_SERVERS = [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
            'stun:stun2.l.google.com:19302',
            'stun:stun3.l.google.com:19302',
            'stun:stun4.l.google.com:19302'
          ];
        this.pc_.setup(chan.identifier, 'SocksToRtc-' + peerId, STUN_SERVERS).then(
          () => {
            dbg('SocksToRtc peer connection setup succeeded');
            freedom.emit('socksToRtcSuccess', remotePeer);
            this.startPingPong_();
          }
        ).catch(
          (e) => {
            dbgErr('SocksToRtc peer connection setup failed ' + e);
            freedom.emit('socksToRtcFailure', remotePeer);
          }
        );

        // Signalling channel messages are batched and dispatched each second.
        // TODO: kill this loop!
        // TODO: size limit on batched message
        // TODO: this code is completely common to rtc-to-net (growing need for shared lib)
        var queuedMessages = [];
        setInterval(() => {
          if (queuedMessages.length > 0) {
            dbg('dispatching signalling channel messages...');
            freedom.emit('sendSignalToPeer', {
              peerId: peerId,
              data: JSON.stringify({
                version: 1,
                messages: queuedMessages
              })
            });
            queuedMessages = [];
          }
        }, 1000);

        this.signallingChannel_ = chan.channel;
        this.signallingChannel_.on('message', function(msg) {
          dbg('signalling channel message: ' + msg);
          queuedMessages.push(msg);
        });
        dbg('signalling channel to SCTP peer connection ready.');
        // Open a datachannel to initiate the peer connection.
        // This will cause the promise returned by this.pc_.setup to fulfill.
        dbg('initiating peer connection...');
        this.pc_.openDataChannel('pingpong');
      });  // fCore.createChannel

      // Create SOCKS server and start listening.
      this.socksServer_ = new Socks.Server(remotePeer.host, remotePeer.port,
                                          this.createChannel_);
      this.socksServer_.listen();
    }

    // Closes the peer connection.
    public close = () => {
      if (this.pc_) {
        // Close peer connection; onCloseHandler_ will reset state.
        this.pc_.close();
      } else {
        // Peer connection already closed, just call reset.
        this.reset_();
      }
    }

    // Invoked when the peer connection has terminated.
    private onCloseHandler_ = () => {
      dbg('peer connection has closed!')
      // Set this.pc_ to null so reset_ doesn't attempt to close it again.
      this.pc_ = null;
      this.reset_();
    }

    /**
     * Stop SOCKS server and close data channels and peer connections.
     */
    private reset_ = () => {
      dbg('resetting...');
      this.stopPingPong_();
      if (this.socksServer_) {
        this.socksServer_.disconnect();  // Disconnects internal TCP server.
        this.socksServer_ = null;
      }
      for (var tag in this.channels_) {
        this.closeConnectionToPeer(tag);
      }
      this.channels_ = {};
      if (this.pc_) {
        this.pc_.close();
        this.pc_ = null;
      }
      this.signallingChannel_ = null;
      this.peerId_ = null;
      this.remotePeer_ = null;
    }

    /**
     * Setup a new data channel.
     */
    private createChannel_ = (params:Channel.EndpointInfo) : Promise<Channel.EndpointInfo> => {
      if (!this.pc_) {
        dbgWarn('peer connection not ready');
        return;
      }

      // Generate a name for this connection and associate it with the SOCKS session.
      var tag = obtainTag();
      this.channels_[tag] = params;

      // This gets a little funky: ask the peer to establish a connection to
      // the remote host and register a callback for when it gets back to us
      // on the control channel.
      // TODO: how to add a timeout, in case the remote end never replies?
      return this.pc_.openDataChannel(tag).then(() => {
        return new Promise((F, R) => {
          Peer.connectCallbacks[tag] = (response:Channel.NetConnectResponse) => {
            if (response.address) {
              var endpointInfo:Channel.EndpointInfo = {
                protocol: params.protocol,
                address: response.address,
                port: response.port,
                send: (buf:ArrayBuffer) => { this.sendToPeer_(tag, buf); },
                terminate: () => { this.terminate_(tag); }
              };
              F(endpointInfo);
            } else {
              R(new Error('could not connect to remote endpoint'));
            }
          };

          var request:Channel.NetConnectRequest = {
            type: Channel.COMMANDS.NET_CONNECT_REQUEST,
            protocol: params.protocol,
            address: params.address,
            port: params.port
          };
          this.pc_.send({
            channelLabel: tag,
            text: JSON.stringify(request)
          });
        });
      }, (e) => {
        dbgErr('could not establish data channel');
        return Promise.reject(e);
      });
    }

    // Invoked by the SOCKS server when the TCP connection between itself
    // and the SOCKS client terminates.
    // TODO: currently, socks.ts does *not* call this, due to tcp.ts brokenness
    private terminate_ = (tag:string) => {
      if (!(tag in this.channels_)) {
        dbgWarn('tried to terminate unknown datachannel ' + tag);
        return;
      }
      dbg('terminating datachannel ' + tag);
      var command:Channel.Command = {
        type: Channel.COMMANDS.SOCKS_DISCONNECTED
      };
      this.pc_.send({
        channelLabel: tag,
        text: JSON.stringify(command)
      });
      delete this.channels_[tag];
    }

    /**
     * Receive replies proxied back from the remote RtcToNet.Peer and pass them
     * back across underlying SOCKS session / TCP socket.
     */
    // TODO: freedom.PeerConnection.ChannelMessage
    private onDataFromPeer_ = (msg:any) => {
      if (!msg.channelLabel) {
        dbgErr('received message without datachannel tag!: ' + JSON.stringify(msg));
        return;
      }

      if (msg.text) {
        var command:Channel.Command = JSON.parse(msg.text);
        if (command.type === Channel.COMMANDS.NET_CONNECT_RESPONSE) {
          // Call the associated callback and forget about it.
          // The callback should fulfill or reject the promise on
          // which the client is waiting, completing the connection flow.
          var response:Channel.NetConnectResponse = <Channel.NetConnectResponse>command;
          if (msg.channelLabel in Peer.connectCallbacks) {
            var callback = Peer.connectCallbacks[msg.channelLabel];
            callback(response);
            delete Peer.connectCallbacks[msg.channelLabel];
          } else {
            dbgErr('received connect callback for unknown datachannel: ' +
                msg.channelLabel);
          }
        } else if (command.type === Channel.COMMANDS.NET_DISCONNECTED) {
          // Receiving a disconnect on the remote peer should close SOCKS.
          dbg(msg.channelLabel + ' <--- received NET-DISCONNECTED');
          this.closeConnectionToPeer(msg.channelLabel);
        } else if (command.type === Channel.COMMANDS.PONG) {
          this.lastPingPongReceiveDate_ = new Date(); 
        } else {
          dbgErr('unsupported control command: ' + command.type);
        }
      } else if (msg.buffer) {
        if (!(msg.channelLabel in this.channels_)) {
          dbgErr('unknown datachannel ' + msg.channelLabel);
          return;
        }
        var session = this.channels_[msg.channelLabel];
        session.send(msg.buffer);
      } else {
        dbgErr('message received without text or buffer');
      }
    }

    /**
     * Calls the endpoint's terminate() method and discards our reference
     * to the channel. Intended for use when the remote side has been
     * disconnected.
     */
    private closeConnectionToPeer = (tag:string) => {
      if (!(tag in this.channels_)) {
        dbgWarn('unknown datachannel ' + tag + ' has closed');
        return;
      }
      dbg('datachannel ' + tag + ' has closed. ending SOCKS session for channel.');
      // TODO: Why not just have rtc-to-net close the data channel and listen
      //       for onCloseDataChannel events in this module?
      this.channels_[tag].terminate();
      delete this.channels_[tag];
    }

    /**
     * Sends data over the peer connection.
     */
    private sendToPeer_ = (tag:string, buffer:ArrayBuffer) => {
      if (!this.pc_) {
        dbgWarn('peer connection not ready');
        return;
      }
      dbg('send ' + buffer.byteLength + ' bytes on datachannel ' + tag);
      this.pc_.send({
        channelLabel: tag,
        buffer: buffer
      });
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
      // TODO: this code is completely common to rtc-to-net (growing need for shared lib)
      try {
        var batchedMessages :any = JSON.parse(msg.data);
        if (batchedMessages.version != 1) {
          throw new Error('only version 1 batched messages supported');
        }
        for (var i = 0; i < batchedMessages.messages.length; i++) {
          var message = batchedMessages.messages[i];
          dbg('received signalling channel message: ' + message);
          this.signallingChannel_.emit('message', message);
        }
      } catch (e) {
        dbgErr('could not parse batched messages: ' + e.message);
      }
    }

    public toString = () => {
      var ret ='<SocksToRTC.Peer: failed toString()>';
      try {
        ret = JSON.stringify({ socksServer: this.socksServer_,
                               pc: this.pc_,
                               peerId: this.peerId_,
                               signallingChannel: this.signallingChannel_,
                               channels: this.channels_ });
      } catch (e) {}
      return ret;
    }

    /**
     * Sets up ping-pong (heartbearts and acks) with socks-to-rtc client.
     * This is necessary to detect disconnects from the other peer, since
     * WebRtc does not yet notify us if the peer disconnects (to be fixed
     * Chrome version 37), at which point we should be able to remove this code.
     */
    private startPingPong_ = () => {
      this.pc_.openDataChannel('pingpong').then(() => {
        this.pingPongSendIntervalId_ = setInterval(() => {
          var command :Channel.Command = {type: Channel.COMMANDS.PING};
          this.pc_.send({
            channelLabel: 'pingpong',
            text: JSON.stringify(command)
          });
        }, 1000);

        var PING_PONG_CHECK_INTERVAL_MS :number = 10000;
        this.pingPongCheckIntervalId_ = setInterval(() => {
          var nowDate = new Date();
          if (!this.lastPingPongReceiveDate_ ||
              (nowDate.getTime() - this.lastPingPongReceiveDate_.getTime()) >
               PING_PONG_CHECK_INTERVAL_MS) {
            dbgWarn('no ping-pong detected, closing peer');
            // Save remotePeer before closing because it will be reset.
            var remotePeer = this.remotePeer_;
            this.close();
            freedom.emit('socksToRtcTimeout', remotePeer);
          }
        }, PING_PONG_CHECK_INTERVAL_MS);
      });
    }

    private stopPingPong_ = () => {
      // Stop setInterval functions.
      if (this.pingPongSendIntervalId_ !== null) {
        clearInterval(this.pingPongSendIntervalId_);
        this.pingPongSendIntervalId_ = null;
      }
      if (this.pingPongCheckIntervalId_ !== null) {
        clearInterval(this.pingPongCheckIntervalId_);
        this.pingPongCheckIntervalId_ = null;
      }
      this.lastPingPongReceiveDate_ = null;
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
  freedom.on('stop', peer.close);
  freedom.emit('ready', {});
}


initClient();
