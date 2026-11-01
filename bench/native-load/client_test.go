package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// These byte fixtures are the protocol oracle; no expected response is produced
// by the parser or request builder under test.
func TestResponseFixtures(t *testing.T) {
	tests := []struct {
		name, response, expected string
		closed, failed           bool
	}{
		{"content length", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello", "hello", false, false},
		{"chunked with trailers", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;tag=x\r\nhe\r\n3\r\nllo\r\n0\r\nX-Test: done\r\n\r\n", "hello", false, false},
		{"connection close", "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhello", "hello", true, false},
		{"empty", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", "", false, false},
		{"wrong bytes", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\njello", "hello", false, true},
		{"wrong length", "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nhell", "hello", false, true},
		{"non 200 success", "HTTP/1.1 201 Created\r\nContent-Length: 5\r\n\r\nhello", "hello", false, true},
		{"server error", "HTTP/1.1 500 Error\r\nContent-Length: 5\r\n\r\nhello", "hello", false, true},
		{"mid body disconnect", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel", "hello", false, true},
		{"mid chunk disconnect", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel", "hello", false, true},
		{"excess chunk bytes", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nhelloo\r\n0\r\n\r\n", "hello", false, true},
		{"close excess bytes", "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nhelloo", "hello", false, true},
		{"conflicting framing", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n", "hello", false, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			closed, err := readResponse(bufio.NewReader(strings.NewReader(test.response)), make([]byte, len(test.expected)+1), []byte(test.expected), false)
			if (err != nil) != test.failed {
				t.Fatalf("failed = %v, want %v: %v", err != nil, test.failed, err)
			}
			if err == nil && closed != test.closed {
				t.Fatalf("connection close = %v, want %v", closed, test.closed)
			}
		})
	}
}

func fixtureServer(t *testing.T, serve func(net.Conn, int32)) (string, *atomic.Int32) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int32
	var running sync.WaitGroup
	var connections sync.Map
	running.Add(1)
	go func() {
		defer running.Done()
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Store(connection, true)
			index := accepted.Add(1)
			running.Add(1)
			go func() {
				defer running.Done()
				defer connections.Delete(connection)
				defer connection.Close()
				_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
				serve(connection, index)
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		connections.Range(func(connection, _ any) bool {
			_ = connection.(net.Conn).Close()
			return true
		})
		running.Wait()
	})
	return "http://" + listener.Addr().String() + "/fixture?q=1", &accepted
}

func readFixtureRequest(connection net.Conn) (string, error) {
	reader := bufio.NewReader(connection)
	var request strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return "", err
		}
		request.WriteString(line)
		if line == "\r\n" {
			return request.String(), nil
		}
	}
}

func TestConnectionCloseReconnectAndRequest(t *testing.T) {
	requests := make(chan string, 2)
	address, accepted := fixtureServer(t, func(connection net.Conn, _ int32) {
		request, err := readFixtureRequest(connection)
		if err != nil {
			return
		}
		requests <- request
		_, _ = io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
	})
	runner, err := newRunner(options{URL: address, Method: "POST", Connections: 1, Duration: 1, ExpectBody: "ok"})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.close()
	for range 2 {
		if err := runner.workers[0].roundTrip(context.Background()); err != nil {
			t.Fatal(err)
		}
		request := <-requests
		if !strings.HasPrefix(request, "POST /fixture?q=1 HTTP/1.1\r\n") || !strings.Contains(request, "\r\nContent-Length: 0\r\n") {
			t.Fatalf("unexpected request: %q", request)
		}
		if strings.Contains(strings.ToLower(request), "user-agent:") || strings.Contains(strings.ToLower(request), "accept-encoding:") {
			t.Fatalf("unrequested header: %q", request)
		}
	}
	if accepted.Load() != 2 {
		t.Fatalf("accepted %d connections, want 2", accepted.Load())
	}
}

func TestDisconnectFailsWithoutRetryAndCleansUp(t *testing.T) {
	address, accepted := fixtureServer(t, func(connection net.Conn, _ int32) {
		_, _ = readFixtureRequest(connection)
		_, _ = io.WriteString(connection, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\no")
	})
	runner, err := newRunner(options{URL: address, Connections: 1, Duration: 1, ExpectBody: "ok"})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.close()
	err = runner.runPhase(time.Now(), 20*time.Millisecond)
	if err == nil {
		t.Fatal("mid-body disconnect must fail the phase")
	}
	if accepted.Load() != 1 {
		t.Fatalf("failed request was retried: accepted %d", accepted.Load())
	}
	if runner.workers[0].connection != nil {
		t.Fatal("failed connection was not closed")
	}
}

func TestRejectNonLoopback(t *testing.T) {
	for _, address := range []string{"https://127.0.0.1/", "http://192.0.2.1/", "http://example.com/"} {
		if _, err := newRunner(options{URL: address, Connections: 1, Duration: 1}); err == nil {
			t.Fatal(fmt.Sprintf("accepted unsupported target %s", address))
		}
	}
}
