# rtl-relay

Shares one RTL-SDR between several clients on a Raspberry Pi. `rtl_tcp` owns the dongle on
`127.0.0.1:1234`; the relay connects to it and serves the same IQ stream to every client:

- WebSocket on `:8765` for the BrowSDR **RTL-TCP** source and `browsdr-cli`, plus `GET /status` (JSON);
- plain rtl_tcp on `:1234` for SDR++, GQRX and other rtl_tcp clients.

Go standard library only, no dependencies.

## Who may tune

Every client hears the same band. Only the controller's commands reach `rtl_tcp`. The controller is
the first client to join, or a WebSocket client that connects with `?control=take`. Commands
from other clients are dropped and counted as `ignored_commands` in `/status`. When the controller
leaves, the oldest remaining client takes over. The upstream connection opens with the first client
and closes after the last one leaves. If `rtl_tcp` drops, every client is closed. A slow client loses
whole I/Q-aligned chunks and does not slow the others down.

## Build and test

Build in WSL or Linux (the Windows antivirus flags Go executables):

```sh
go test -race ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags="-s -w" -o ~/build/rtl-relay .
```

## Install on the Pi

`deploy/` holds the system files running on `radiopi`, a Raspberry Pi 2 on Debian 13 trixie
with the `rtl-sdr` package installed. On the Pi:

```sh
sudo install -m 755 rtl-relay /usr/local/bin/rtl-relay
sudo install -m 644 deploy/rtl-tcp.service deploy/rtl-relay.service /etc/systemd/system/
sudo install -m 644 deploy/90-rtl-tcp-restart.rules /etc/udev/rules.d/
sudo install -m 644 deploy/blacklist-rtlsdr.conf /etc/modprobe.d/
sudo udevadm control --reload && sudo systemctl daemon-reload
sudo systemctl enable --now rtl-tcp rtl-relay
```

- **udev rule:** restarts `rtl-tcp` when the dongle re-enumerates after a USB drop. Without it,
  `rtl_tcp` stays alive with no device behind it.
- **Listen addresses:** `rtl-relay.service` listens only on the cable link's address,
  `192.168.250.2`. Change `-tcp` and `-http` for another network.
- **CLI tools:** to run `rtl_power`, `rtl_433` or `readsb` directly, first run
  `sudo systemctl stop rtl-relay rtl-tcp`.
