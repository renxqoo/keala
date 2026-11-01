// A deliberately narrow HTTP/1.1 benchmark driver. It has one in-flight request
// per connection, validates every response, and never retries a failed request.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const ioTimeout = 5 * time.Second

type options struct {
	URL         string `json:"url"`
	Method      string `json:"method"`
	ExpectBody  string `json:"expectBody"`
	Connections int    `json:"connections"`
	Duration    int    `json:"duration"`
}

type command struct {
	Kind    string  `json:"kind"`
	Options options `json:"options"`
}

type worker struct {
	address    string
	request    []byte
	expected   []byte
	body       []byte
	head       bool
	connection net.Conn
	reader     *bufio.Reader
	histogram  []uint64
	completed  uint64
	totalNs    uint64
}

type loadRunner struct {
	options options
	workers []*worker
}

func newRunner(config options) (*loadRunner, error) {
	if config.Connections < 1 || config.Connections > 4096 || config.Duration < 1 || config.Duration > 86400 {
		return nil, errors.New("connections must be 1..4096; duration must be 1..86400 seconds")
	}
	parsed, err := url.Parse(config.URL)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("native client requires a loopback http URL without credentials or fragment")
	}
	host := parsed.Hostname()
	if host == "localhost" {
		host = "127.0.0.1"
	} else if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return nil, errors.New("native client only supports numeric loopback hosts or localhost")
	}
	port := parsed.Port()
	if port == "" {
		port = "80"
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return nil, errors.New("invalid target port")
	}
	if config.Method == "" {
		config.Method = "GET"
	}
	for _, char := range config.Method {
		if !(char >= 'A' && char <= 'Z') {
			return nil, errors.New("method must contain uppercase ASCII letters")
		}
	}
	if config.Method == "CONNECT" || (config.Method == "HEAD" && config.ExpectBody != "") {
		return nil, errors.New("CONNECT and HEAD with an expected body are unsupported")
	}
	if len(config.ExpectBody) > 1024*1024 {
		return nil, errors.New("expected body exceeds 1MiB")
	}
	request := config.Method + " " + parsed.RequestURI() + " HTTP/1.1\r\nHost: " + parsed.Host + "\r\nConnection: keep-alive\r\n"
	if config.Method == "POST" || config.Method == "PUT" || config.Method == "PATCH" {
		request += "Content-Length: 0\r\n"
	}
	requestBytes := []byte(request + "\r\n")
	expected := []byte(config.ExpectBody)
	runner := &loadRunner{options: config}
	for range config.Connections {
		runner.workers = append(runner.workers, &worker{
			address: net.JoinHostPort(host, port), request: requestBytes,
			expected: expected, body: make([]byte, len(expected)+1), head: config.Method == "HEAD",
			histogram: make([]uint64, 10001),
		})
	}
	return runner, nil
}

func (worker *worker) close() {
	if worker.connection != nil {
		_ = worker.connection.Close()
		worker.connection = nil
	}
}

func (runner *loadRunner) close() {
	for _, worker := range runner.workers {
		worker.close()
	}
}

func (worker *worker) roundTrip(ctx context.Context) error {
	if worker.connection == nil {
		dialer := net.Dialer{Timeout: ioTimeout}
		connection, err := dialer.DialContext(ctx, "tcp", worker.address)
		if err != nil {
			return err
		}
		worker.connection = connection
		if worker.reader == nil {
			worker.reader = bufio.NewReaderSize(connection, 16384)
		} else {
			worker.reader.Reset(connection)
		}
	}
	if err := worker.connection.SetDeadline(time.Now().Add(ioTimeout)); err != nil {
		worker.close()
		return err
	}
	request := worker.request
	for len(request) > 0 {
		written, err := worker.connection.Write(request)
		if err != nil {
			worker.close()
			return err
		}
		if written == 0 {
			worker.close()
			return io.ErrNoProgress
		}
		request = request[written:]
	}
	closed, err := readResponse(worker.reader, worker.body, worker.expected, worker.head)
	if closed || err != nil {
		worker.close()
	}
	return err
}

func line(reader *bufio.Reader) ([]byte, error) {
	value, err := reader.ReadSlice('\n')
	if err != nil {
		return nil, err
	}
	if len(value) < 2 || value[len(value)-2] != '\r' {
		return nil, errors.New("HTTP line is not CRLF terminated")
	}
	return value[:len(value)-2], nil
}

func unsigned(value []byte, base uint64) (uint64, error) {
	if len(value) == 0 {
		return 0, errors.New("empty HTTP length")
	}
	var number uint64
	for _, char := range value {
		var digit uint64
		if char >= '0' && char <= '9' {
			digit = uint64(char - '0')
		} else if char >= 'a' && char <= 'f' {
			digit = uint64(char-'a') + 10
		} else if char >= 'A' && char <= 'F' {
			digit = uint64(char-'A') + 10
		} else {
			return 0, errors.New("invalid HTTP length digit")
		}
		if digit >= base || number > (1<<53-1-digit)/base {
			return 0, errors.New("invalid or overflowing HTTP length")
		}
		number = number*base + digit
	}
	return number, nil
}

func hasToken(value []byte, token string) bool {
	for len(value) > 0 {
		item, rest, _ := bytes.Cut(value, []byte(","))
		if bytes.EqualFold(bytes.TrimSpace(item), []byte(token)) {
			return true
		}
		value = rest
	}
	return false
}

func readResponse(reader *bufio.Reader, body, expected []byte, head bool) (bool, error) {
	status, err := line(reader)
	if err != nil {
		return false, err
	}
	if len(status) < 12 || !(bytes.Equal(status[:9], []byte("HTTP/1.1 ")) || bytes.Equal(status[:9], []byte("HTTP/1.0 "))) || !bytes.Equal(status[9:12], []byte("200")) || (len(status) > 12 && status[12] != ' ') {
		return false, fmt.Errorf("expected HTTP status 200, received %q", status)
	}
	http10 := status[7] == '0'
	closeConnection := http10
	contentLength := uint64(0)
	hasLength, chunked := false, false
	headerBytes := 0
	for {
		header, err := line(reader)
		if err != nil {
			return false, err
		}
		headerBytes += len(header) + 2
		if headerBytes > 65536 {
			return false, errors.New("response headers exceed 64KiB")
		}
		if len(header) == 0 {
			break
		}
		name, value, found := bytes.Cut(header, []byte(":"))
		if !found || len(name) == 0 {
			return false, errors.New("malformed response header")
		}
		value = bytes.TrimSpace(value)
		switch {
		case bytes.EqualFold(name, []byte("Content-Length")):
			if hasLength {
				return false, errors.New("duplicate Content-Length")
			}
			contentLength, err = unsigned(value, 10)
			if err != nil {
				return false, err
			}
			hasLength = true
		case bytes.EqualFold(name, []byte("Transfer-Encoding")):
			if chunked || !bytes.EqualFold(value, []byte("chunked")) {
				return false, errors.New("only a single chunked transfer coding is supported")
			}
			chunked = true
		case bytes.EqualFold(name, []byte("Connection")):
			if hasToken(value, "close") {
				closeConnection = true
			} else if http10 && hasToken(value, "keep-alive") {
				closeConnection = false
			}
		}
	}
	if chunked && hasLength {
		return false, errors.New("response has both Transfer-Encoding and Content-Length")
	}
	if head {
		return closeConnection, nil
	}
	if chunked {
		offset := 0
		for {
			chunk, err := line(reader)
			if err != nil {
				return false, err
			}
			sizeText, _, _ := bytes.Cut(chunk, []byte(";"))
			size, err := unsigned(sizeText, 16)
			if err != nil || size > uint64(len(expected)-offset) {
				return false, errors.New("invalid chunk length or unexpected response body length")
			}
			if size == 0 {
				for {
					trailer, err := line(reader)
					if err != nil {
						return false, err
					}
					headerBytes += len(trailer) + 2
					if headerBytes > 65536 {
						return false, errors.New("response trailers exceed 64KiB")
					}
					if len(trailer) == 0 {
						break
					}
					if !bytes.Contains(trailer, []byte(":")) {
						return false, errors.New("malformed response trailer")
					}
				}
				if offset != len(expected) {
					return false, errors.New("unexpected response body length")
				}
				break
			}
			end := offset + int(size)
			if _, err := io.ReadFull(reader, body[offset:end]); err != nil {
				return false, err
			}
			offset = end
			ending, err := line(reader)
			if err != nil || len(ending) != 0 {
				return false, errors.New("invalid chunk terminator")
			}
		}
	} else if hasLength {
		if contentLength != uint64(len(expected)) {
			return false, errors.New("unexpected response Content-Length")
		}
		if _, err := io.ReadFull(reader, body[:len(expected)]); err != nil {
			return false, err
		}
	} else {
		// No framing means EOF is the delimiter, even without Connection: close.
		closeConnection = true
		count, err := io.ReadFull(reader, body[:len(expected)+1])
		if count != len(expected) || (err != io.EOF && err != io.ErrUnexpectedEOF) {
			return false, errors.New("unexpected close-delimited body or missing EOF")
		}
	}
	if !bytes.Equal(body[:len(expected)], expected) {
		return false, errors.New("response body mismatch")
	}
	return closeConnection, nil
}

func (runner *loadRunner) reset() {
	for _, worker := range runner.workers {
		clear(worker.histogram)
		worker.completed, worker.totalNs = 0, 0
	}
}

// Stop issuing requests at the shared deadline, then drain the final in-flight
// requests. Their completions and the drain time belong to the measured window.
func (runner *loadRunner) runPhase(start time.Time, duration time.Duration) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	end := start.Add(duration)
	var running sync.WaitGroup
	var first sync.Once
	var failure error
	for _, worker := range runner.workers {
		running.Add(1)
		go func() {
			defer running.Done()
			for {
				started := time.Now()
				if !started.Before(end) || ctx.Err() != nil {
					return
				}
				if err := worker.roundTrip(ctx); err != nil {
					first.Do(func() { failure = err; cancel() })
					return
				}
				latency := time.Since(started)
				ms := int(latency.Milliseconds())
				if ms >= len(worker.histogram) {
					worker.histogram = append(worker.histogram, make([]uint64, ms+1-len(worker.histogram))...)
				}
				worker.histogram[ms]++
				worker.completed++
				worker.totalNs += uint64(latency.Nanoseconds())
			}
		}()
	}
	running.Wait()
	if failure != nil {
		return failure
	}
	for _, worker := range runner.workers {
		if worker.completed == 0 {
			return errors.New("a connection completed no requests during the phase")
		}
	}
	return nil
}

func usage() (int64, int64, error) {
	var resource syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &resource); err != nil {
		return 0, 0, err
	}
	return resource.Utime.Sec*1000000 + int64(resource.Utime.Usec), resource.Stime.Sec*1000000 + int64(resource.Stime.Usec), nil
}

func send(value any) error {
	return json.NewEncoder(os.Stdout).Encode(value)
}

func receive(scanner *bufio.Scanner, kind string) (command, error) {
	var input command
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return input, err
		}
		return input, errors.New("parent closed control input")
	}
	decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, err
	}
	if input.Kind != kind {
		return input, fmt.Errorf("expected %s command, received %s", kind, input.Kind)
	}
	return input, nil
}

func run() error {
	if os.Getenv("NODE_ENV") != "production" {
		return errors.New("native client requires NODE_ENV=production")
	}
	if err := send(map[string]any{"kind": "ready"}); err != nil {
		return err
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	warmup, err := receive(scanner, "warmup")
	if err != nil {
		return err
	}
	runner, err := newRunner(warmup.Options)
	if err != nil {
		return err
	}
	defer runner.close()
	if err := runner.runPhase(time.Now(), time.Second); err != nil {
		return fmt.Errorf("warmup failed: %w", err)
	}
	runner.reset()
	if err := send(map[string]any{"kind": "warmed"}); err != nil {
		return err
	}
	if _, err := receive(scanner, "run"); err != nil {
		return err
	}
	userBefore, systemBefore, err := usage()
	if err != nil {
		return err
	}
	started := time.Now()
	if err := runner.runPhase(started, time.Duration(runner.options.Duration)*time.Second); err != nil {
		return fmt.Errorf("measurement failed: %w", err)
	}
	finished := time.Now()
	userAfter, systemAfter, err := usage()
	if err != nil {
		return err
	}
	merged := make(map[int]uint64)
	var total, totalNs uint64
	for _, worker := range runner.workers {
		total += worker.completed
		totalNs += worker.totalNs
		for ms, count := range worker.histogram {
			if count != 0 {
				merged[ms] += count
			}
		}
	}
	keys := make([]int, 0, len(merged))
	for ms := range merged {
		keys = append(keys, ms)
	}
	sort.Ints(keys)
	bins := make([][2]uint64, 0, len(keys))
	for _, ms := range keys {
		bins = append(bins, [2]uint64{uint64(ms), merged[ms]})
	}
	return send(map[string]any{
		"kind": "result", "pid": os.Getpid(), "env": "production", "runtimeVersion": runtime.Version(),
		"connections": runner.options.Connections, "startedAt": started.UnixMilli(), "finishedAt": finished.UnixMilli(),
		"cpu":                    map[string]any{"user": userAfter - userBefore, "system": systemAfter - systemBefore, "elapsedUs": float64(finished.Sub(started).Nanoseconds()) / 1000},
		"totalCompletedRequests": total, "totalLatencyNs": totalNs, "bins": bins,
	})
}

func main() {
	if err := run(); err != nil {
		message := strings.TrimSpace(err.Error())
		_, _ = fmt.Fprintln(os.Stderr, message)
		_ = send(map[string]any{"kind": "error", "error": message})
		os.Exit(1)
	}
}
