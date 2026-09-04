// Go shootout baseline — stdlib net/http (Go 1.22 ServeMux patterns),
// implementing the shared 12-route table with the same response bytes as the
// JS servers in bench/route-shootout/servers/.
//
// Usage: server-shootout-go <port>
package main

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

const textCT = "text/plain; charset=utf-8"

func text(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", textCT)
		w.Write([]byte(body))
	}
}

func echo(value string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", textCT)
		w.Write([]byte(value))
	}
}

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

func main() {
	port := "4206"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}
	mux := http.NewServeMux()

	// The shared 12-route table (registration order mirrors the JS servers).
	mux.HandleFunc("GET /user", text("user"))
	mux.HandleFunc("GET /user/comments", text("user/comments"))
	mux.HandleFunc("GET /user/avatar", text("user/avatar"))
	mux.HandleFunc("GET /user/lookup/username/{username}", echoPathValue("username"))
	mux.HandleFunc("GET /user/lookup/email/{address}", echoPathValue("address"))
	mux.HandleFunc("GET /event/{id}", echoPathValue("id"))
	mux.HandleFunc("GET /event/{id}/comments", echoPathValue("id"))
	mux.HandleFunc("POST /event/{id}/comment", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", textCT)
		w.Write([]byte(r.PathValue("id") + " comment"))
	})
	mux.HandleFunc("GET /map/{location}/events", echoPathValue("location"))
	mux.HandleFunc("GET /status", text("status"))
	mux.HandleFunc("GET /very/deeply/nested/route/hello/there", text("hello there"))
	mux.HandleFunc("GET /static/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", textCT)
		w.Write([]byte(r.PathValue("rest")))
	})

	mux.HandleFunc("GET /debug/memory", debugMemory)

	http.ListenAndServe("127.0.0.1:"+port, mux)
}

func echoPathValue(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", textCT)
		w.Write([]byte(r.PathValue(name)))
	}
}
