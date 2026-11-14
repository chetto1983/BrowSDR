package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// App serves BrowSDR's static build, the radio (WebSocket on any path) and /status from one
// origin, so a phone opens one address and the page finds the radio next to it.
func App(hub *Hub, staticDir string) http.Handler {
	files := http.FileServer(http.Dir(staticDir))
	radio := ServeWS(hub)
	mux := http.NewServeMux()
	mux.Handle("/status", StatusHandler(hub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if headerHasToken(r.Header, "Upgrade", "websocket") {
			radio(w, r)
			return
		}
		// The page and its service worker must be revalidated, or an upgrade on the Pi never reaches phones.
		if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") || strings.HasSuffix(r.URL.Path, "sw.js") {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
	return mux
}

// LoadOrCreateCert returns the certificate kept in dir, creating a self-signed one for hosts the
// first time. Reusing it matters: each new certificate is another browser warning on every phone.
func LoadOrCreateCert(dir string, hosts []string) (tls.Certificate, error) {
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		return cert, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return tls.Certificate{}, err
	}
	template := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "rtl-relay"},
		// The Pi has no clock battery: start well before "now" in case it boots with a stale date.
		NotBefore:             time.Now().AddDate(0, 0, -7),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, host := range hosts {
		if ip := net.ParseIP(host); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, host)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}

// localHosts lists the names and addresses a phone may use to reach this machine.
func localHosts() []string {
	hosts := []string{"localhost"}
	if name, err := os.Hostname(); err == nil {
		hosts = append(hosts, name, name+".local")
	}
	addrs, _ := net.InterfaceAddrs()
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLinkLocalUnicast() {
			hosts = append(hosts, ipNet.IP.String())
		}
	}
	return hosts
}
