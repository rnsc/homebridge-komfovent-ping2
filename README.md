# Homebridge Komfovent Ping2

![homebridge-logo](https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png)

Homebridge plugin that exposes a Komfovent Domekt ventilation unit (C4 controller) as a Fan accessory in HomeKit. Communicates directly with the PING2 module over **Modbus TCP** (port 502) — no middleware required.

## Features

* **ON/OFF** — start/stop the ventilation unit
* **Fan speed** — set Mode 2 intake and exhaust intensity from 5% to 95% in 5% increments
* **Supply air temperature** — exposed as a TemperatureSensor accessory in HomeKit

## Requirements

* A Komfovent Domekt unit with a **C4 controller** and **PING2 network module**
* The PING2 module must be reachable over TCP on port 502 (Modbus TCP)
* Homebridge >= 1.8.0
* Node.js >= 20.18

## Configuration

Add the platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "KomfoventPing2",
      "devices": [
        {
          "name": "Ventilation",
          "host": "192.168.1.100",
          "deviceId": "abcdef1234567890"
        }
      ]
    }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Display name in HomeKit |
| `host` | Yes | — | IP address or hostname of the PING2 module |
| `deviceId` | Yes | — | 16-character ID (A-Z, a-z, 0-9, _) for HomeKit UUID generation |
| `port` | No | `502` | Modbus TCP port |
| `slaveId` | No | `1` | Modbus slave ID (1-254) |
| `timezone` | No | system | IANA timezone for clock sync (e.g. `Europe/Luxembourg`) |

### Verifying Modbus connectivity

You can verify that your PING2 module is reachable over Modbus TCP using `mbpoll`:

```bash
brew install mbpoll  # or apt-get install mbpoll
mbpoll -m tcp -a 1 -r 1000 -c 10 -t 4 -1 <PING2_IP>
```

## Migration from v0.2.x

Version 0.3.0 replaces the Python middleware ([komfovent-ping2-json-server](https://github.com/rnsc/komfovent-ping2-json-server)) with direct Modbus TCP communication. The middleware server is no longer needed.

Update your config — replace `url` with `host`:

```diff
 {
   "platform": "KomfoventPing2",
   "devices": [
     {
       "name": "Ventilation",
-      "url": "http://192.168.1.100:5000",
+      "host": "192.168.1.100",
       "deviceId": "abcdef1234567890"
     }
   ]
 }
```

Your existing HomeKit accessory will be preserved as long as the `deviceId` stays the same.
