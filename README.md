# uproxy-networking

[![Build Status](https://travis-ci.org/uProxy/uproxy-networking.svg?branch=master)](https://travis-ci.org/uProxy/uproxy-networking) [![devDependency Status](https://david-dm.org/uProxy/uproxy-networking/dev-status.svg)](https://david-dm.org/uProxy/uproxy-networking#info=devDependencies)

uProxy's networking library provides a localhost SOCKS5 proxy that sends traffic over WebRTC to the peer, or recieves traffic from a peer over WebRTC and sends it to the destination website.

This is built on top of [freedom](https://github.com/freedomjs/freedom).

At the moment this only supports chrome; Firefox is in progress and you can test/run the echo-server with it right now.

## Overview

There are two main freedom modules: _socks-to-rtc_ and _rtc-to-net_.

 - _socks-to-rtc_ provides a local proxy (which the user could point their browser proxy settings to) which passes requests over a WebRTC peerconnection.
 - _rtc-to-net_ acts as the 'remote' proxy which receives the requests from the _socks-to-rtc_ peer over WebRTC, passes the request to the destination webserver, and serves the response back to _socks-to-rtc_.

## Requirements

 - [node](http://nodejs.org/) (and [npm](https://www.npmjs.org/), which is installed when you install node)
 - [Grunt](http://gruntjs.com/), which you can install with: `npm install -g grunt-cli`

## Build

 - Run `npm install` from the base directory to obtain all prerequisites.
 - Running `grunt` compiles all the typescript into javascript which goes into the `build` directory.

## Usage

To make use of this library, one needs to include `socks-to-rtc.json`
and `rtc-to-net.json` (the freedom manifests for the two freedom modules)
as dependencies in the parent application's freedom manifest. There will be
the compiled javascript in `build/socks-to-rtc/` and `/build/rtc-to-net/`.
Three things must occur for the two components to speak to each other:

 - In the your 'parent freedom' create instances of the modules. (i.e. `var socksToRtc = freedom.SocksToRtc();` and `var rtcToNet = freedom.RtcToNet();`
 - `rtcToNet.emit('start')` begins the remote peer server.
 - `socksToRtc.emit('start', { host, port, peerId })` begins listening locally, and sends a signal to the remote if _rtc-to-net_'s peerId matches.

This establish a signalling channel between _rtc-to-net_ and _socks-to-rtc_ so that they may communicate. See the chrome app for an example.

## Run the Jasmine Tests

 - run Jasmine tests with `grunt test`

## End-to-End Test with Chrome

### Requirements

 - `chromedriver` must be in your path. You can download it from https://sites.google.com/a/chromium.org/chromedriver/downloads
 - `chrome` must be in a standard path location (see https://code.google.com/p/selenium/wiki/ChromeDriver#Requirements)
 - `addon-sdk` is required for firefox. You can find it at https://developer.mozilla.org/en-US/Add-ons/SDK/Tutorials/Installation

### Automated

We have a Selenium test which starts Chrome with the proxy loaded and its proxy
settings pointing at the proxy. You will need to have the Selenium server
running locally (on localhost:4444). To do this:

 - download the "Standalone Server" from http://docs.seleniumhq.org/download/
 - run the Selenium server, e.g. `java -jar selenium-server-standalone-*.jar`
 - run the test with `grunt endtoend`

### Manual

 - Run `grunt build` to build the chrome app in the `build/chrome-app/` directory.
 - For Chrome, go to `chrome://extensions`, ensure developer mode is enabled, and load unpacked extension the `build/chrome-app` directory.
 - Open the background page, which will start a socks-rtc proxy listening on `localhost:9999`.
 - For Firefox, activate cfx, and run the command `cfx run` from the `build/firefox-app` directory.

At the moment, the way to test that this works is to just curl a webpage through the socks-rtc proxy. For example:

`curl -x socks5h://localhost:9999 www.google.com`

(the 'h' indicates that DNS requests are made through the proxy as well, and not resolved locally.)

There will be more tests soon!

## End-to-End Echo-server Test with Firefox

 - Build using the `grunt` command.
 - Setup the [cfx tool](https://developer.mozilla.org/en-US/Add-ons/SDK/Tutorials/Installation).
 - `cd build/firefox-app` and then run the command `cfx run` which should startup firefox with the Firefox echo-server app running.
 - Use `telnet 127.0.0.1 9998` to verify that echo server echo's what you send it. (type some stuff and see the same stuff repeated back to you). `Ctrl-]` then type `quit` exit telnet.

## Building for Android
uproxy-networking works on Android!
Remember to install the android-sdk such that `android` and `adb` are on your PATH.
* Configure an Android device
  * So far tested on Ubuntu 14.04LTS using an emulated Nexus 4 device running Android L
  * The device MUST be configured with an SD card and "Use Host GPU"
* `grunt cca` will build the project, create an Android APK, and install it onto the device. If no device is attached, the default Android emulator is used
* `adb forward tcp:19999 tcp:9999` will forward localhost:19999 to the emulator's port 9999.
  * This is the SOCKS5 proxy
* `adb forward tcp:19998 tcp:9998` will forward localhost:19998 to the emulator's port 9998.
  * `telnet localhost 19998` is now the echo server on the device
