# bushido

This is a webapp to use your Bushido home trainer with a GPX recording or a planned tour.

In a nutshell, features are:
- loading and smoothing of a GPX route
- connecting to your Bushido trainer (via WebUSB)
- collecting metrics like power, speed, cadence and heart rate
- adjusting slope depending on your current position on the GPX route
- rendering your position into a 3d environment via Cesium
- exporting your stats as a GPX file, so you can share your efforts on Strava or elsewhere

## USB driver

Checkout [the USB driver file](./bushido.usb.js) for a very lightweight Bushido t1980 ANT+ driver. It is capable of reading speed, distance, power, cadence and heart rate from the Bushido control unit. Furthermore, it lets you control the device's simulated slope. This driver sits at the heart of the bushido web simulator software. The Bushido communication protocol is actually proprietary. However, there have been successful attempts in deciphering the different messages. You can [find the documentation here](https://github.com/fluxoid-org/CyclismoProject/wiki/Tacx-Bushido-Headunit-protocol).
