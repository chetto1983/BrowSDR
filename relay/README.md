# rtl-relay

Shares one RTL-SDR between several clients on a Raspberry Pi. `rtl_tcp` owns the dongle on
`127.0.0.1:1234`; the relay connects to it and serves the same IQ stream to every client:

- WebSocket on `:8765` for the BrowSDR **RTL-TCP** source and `browsdr-cli`, plus `GET /status` (JSON);
- plain rtl_tcp on `:1234` for SDR++, GQRX and other rtl_tcp clients;
- with `-https :8443 -static <dir>`: BrowSDR itself, the radio (WebSocket on any path) and
  `/status` on one HTTPS origin, so a phone opens `https://<pi>:8443` and connects with one tap.

Go standard library only, no dependencies.

## BrowSDR from the Pi

- **Why HTTPS:** BrowSDR plays audio through an AudioWorklet, and browsers allow that only on
  HTTPS or localhost, so plain HTTP from the Pi would be silent.
- **Certificate:** the relay creates a self-signed certificate in `-certdir` on first start, for
  the Pi's names and addresses, and reuses it afterwards. Each phone accepts the browser warning
  once. Delete `cert.pem` and `key.pem` there to issue a new one, for example after the Pi's
  address changes for good.
- **Static files:** build with `npm run build` and copy `dist/` to `-static`. A page served this
  way pre-fills the RTL-TCP address with `wss://<the same host>/`.

## Who may tune

Every client hears the same band. Only the controller's commands reach `rtl_tcp`. The controller is
the first client to join, or a WebSocket client that connects with `?control=take`. Commands
from other clients are dropped and counted as `ignored_commands` in `/status`. When the controller
leaves, the oldest remaining client takes over. The upstream connection opens with the first client
and closes after the last one leaves. If `rtl_tcp` drops, every client is closed. A slow client loses
whole I/Q-aligned chunks and does not slow the others down.

A WebSocket client can name itself with `?client=<token>` (1–64 characters of `A-Z a-z 0-9 _ -`;
anything else is ignored). `/status` reports the token as `client` next to `controller`, so a client
can tell for certain whether it holds control. BrowSDR and `browsdr-cli` send a random token on every
connection.

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
sudo install -m 644 deploy/blacklist-rtlsdr.conf deploy/rtl8192cu.conf /etc/modprobe.d/
sudo udevadm control --reload && sudo systemctl daemon-reload
sudo systemctl enable --now rtl-tcp rtl-relay
```

- **udev rule:** restarts `rtl-tcp` when the dongle re-enumerates after a USB drop. Without it,
  `rtl_tcp` stays alive with no device behind it.
- **Listen addresses:** in `rtl-relay.service`, rtl_tcp (`-tcp`) and plain WebSocket (`-http`)
  listen only on the cable link's address, `192.168.250.2`. HTTPS (`-https :8443`) answers on
  every network, Wi-Fi included, so anyone on that Wi-Fi can tune the radio.
- **BrowSDR build:** copy it before restarting the service:
  `sudo rm -rf /usr/local/share/browsdr && sudo cp -r dist /usr/local/share/browsdr`.
- **Wi-Fi dongle:** `rtl8192cu.conf` switches the RTL8192CU Wi-Fi dongle to software crypto.
  With hardware crypto it joins a network but never receives an address.
- **CLI tools:** to run `rtl_power`, `rtl_433` or `readsb` directly, first run
  `sudo systemctl stop rtl-relay rtl-tcp`.
