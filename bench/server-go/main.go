// Go baseline server — stdlib net/http only, mirroring the response shapes
// of the other bench servers (bench/server-*.ts|.mjs).
//
// Usage: server-go <port> [scale]
//
//	base:  /text /json /users/{id} /mw /debug/memory
//	scale: /route-0…/route-999 + /debug/memory (dedicated 1000-route table)
//
// /debug/memory maps Go's runtime metrics onto the report's fields:
// rss from `ps` (Sys over-reports on darwin), heap from ReadMemStats.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

const textCT = "text/plain; charset=utf-8"

func debugMemory(w http.ResponseWriter, _ *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	rss := uint64(m.Sys) // fallback when ps is unavailable
	if out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(os.Getpid())).Output(); err == nil {
		if kb, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); err == nil {
			rss = kb * 1024
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]uint64{
		"rss":       rss,
		"heapUsed":  m.HeapAlloc,
		"heapTotal": m.HeapSys,
		"external":  0,
	})
}

// threeMiddleware mirrors the JS middleware towers (three wrapping layers,
// X-Step/X-Step-2 set on the way in, X-Step-3 on the way out, core writes
// the body). Go flushes headers at the first Write, so the post-next set
// must land before the core runs — same wire result as the JS towers.
func threeMiddleware(core http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Step", "1")   // outer middleware, before next()
		h.Set("X-Step-2", "2") // inner middleware, before next()
		h.Set("X-Step-3", "3") // outer middleware, after next()
		core(w, r)
	}
}

func baseMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /text", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", textCT)
		w.Write([]byte("hello world"))
	})
	mux.HandleFunc("GET /json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"hello":"world"}`))
	})
	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", textCT)
		fmt.Fprintf(w, "user %s", r.PathValue("id"))
	})
	mux.HandleFunc("GET /mw", threeMiddleware(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", textCT)
		w.Write([]byte("middleware"))
	}))
	mux.HandleFunc("GET /debug/memory", debugMemory)
	return mux
}

func scaleMux() *http.ServeMux {
	mux := http.NewServeMux()
	for i := 0; i < 1000; i++ {
		name := fmt.Sprintf("route-%d", i)
		body := name
		mux.HandleFunc("GET /"+name, func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte(body))
		})
	}
	mux.HandleFunc("GET /debug/memory", debugMemory)
	return mux
}

func main() {
	args := os.Args[1:]
	scale := false
	port := 4108
	for _, arg := range args {
		if arg == "scale" {
			scale = true
			continue
		}
		if p, err := strconv.Atoi(arg); err == nil {
			port = p
		}
	}
	mux := baseMux()
	if scale {
		mux = scaleMux()
	}
	server := &http.Server{Addr: "127.0.0.1:" + strconv.Itoa(port), Handler: mux}
	fmt.Printf("go net/http listening on 127.0.0.1:%d (scale=%v)\n", port, scale)
	if err := server.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
