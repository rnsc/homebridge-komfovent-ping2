# Homebridge Komfovent Ping2

![homebridge-logo](https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png)

Due to the lack of capabilities of the PING2 module provided by Komfovent (no API, simple HTML forms), this plugin aims at exposing the Komfovent Domekt unit as a simple fan.

The plugin relies on a middleware server written in Python to abstract the rather awful HTML forms from the PING2 module for the Homebridge code. [link](https://github.com/rnsc/komfovent-ping2-json-server)

Ideally the functions covered will be:

* ON/OFF
* Set the fan speed by 5% increment through the fan accessory in Homekit

Package currently in development and doesn't function properly (01/2023)
