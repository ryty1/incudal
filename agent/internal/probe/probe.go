// Package probe 在节点本机对中国大陆三网节点做连通性探测。
//
// v4 走 ICMP（三大运营商公共 DNS 的 IP，响应稳定，不受 80 端口/HTTP 策略影响）；
// v6 仍走 TCP（CDN 探测点的 v6 地址不保证回 ICMPv6）。
// 得到的是「节点 → 中国大陆」的真实延迟与丢包，跟面板自己测节点是两回事。
package probe

import (
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

// Target 一个探测目标
type Target struct {
	Key    string // gd-cu-v4
	City   string // gd | sh
	ISP    string // cu | cm | ct
	Family string // v4 | v6
	Host   string // IP 或域名
	Method string // "icmp" 或端口号（如 "80"）
}

// Result 单个目标的探测结果
type Result struct {
	Key       string   `json:"key"`
	LatencyMs *float64 `json:"latencyMs"`
	LossPct   int      `json:"lossPct"`
	Samples   int      `json:"samples"`
}

var targets = []Target{
	// 广东 · ICMP 到运营商 DNS
	{"gd-cu-v4", "gd", "cu", "v4", "210.21.196.6", "icmp"},
	{"gd-cm-v4", "gd", "cm", "v4", "211.136.20.203", "icmp"},
	{"gd-ct-v4", "gd", "ct", "v4", "202.96.128.86", "icmp"},
	// 上海 · ICMP 到运营商 DNS
	{"sh-cu-v4", "sh", "cu", "v4", "112.64.235.107", "icmp"},
	{"sh-cm-v4", "sh", "cm", "v4", "211.136.112.200", "icmp"},
	{"sh-ct-v4", "sh", "ct", "v4", "202.96.209.133", "icmp"},
	// 广东 / 上海 · IPv6 仍走 TCP
	{"gd-cu-v6", "gd", "cu", "v6", "gd-cu-v6.ip.zstaticcdn.com", "80"},
	{"gd-cm-v6", "gd", "cm", "v6", "gd-cm-v6.ip.zstaticcdn.com", "80"},
	{"gd-ct-v6", "gd", "ct", "v6", "gd-ct-v6.ip.zstaticcdn.com", "80"},
	{"sh-cu-v6", "sh", "cu", "v6", "sh-cu-v6.ip.zstaticcdn.com", "80"},
	{"sh-cm-v6", "sh", "cm", "v6", "sh-cm-v6.ip.zstaticcdn.com", "80"},
	{"sh-ct-v6", "sh", "ct", "v6", "sh-ct-v6.ip.zstaticcdn.com", "80"},
	// 出站自检：国内站点 + 国际站点各一个
	{"cn-bd-v4", "cn", "bd", "v4", "www.baidu.com", "80"},
	{"us-cf-v4", "us", "cf", "v4", "1.1.1.1", "80"},
}

const (
	attempts = 3
	timeout  = 1500 * time.Millisecond
)

// HasGlobalIPv4 / HasGlobalIPv6 判断本机是否有对应的公网出口
func HasGlobalIPv4() bool {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return true // 判断失败就当作有，交给探测结果说话
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if v4 := ipnet.IP.To4(); v4 != nil && !v4.IsLinkLocalUnicast() {
				return true
			}
		}
	}
	return false
}

func HasGlobalIPv6() bool {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			ip := ipnet.IP
			if ip.To4() == nil && ip.To16() != nil && !ip.IsLinkLocalUnicast() {
				return true
			}
		}
	}
	return false
}

// tcpOnce 单次 TCP 建连耗时，失败返回 -1
func tcpOnce(host, port string) int64 {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), timeout)
	if err != nil {
		return -1
	}
	elapsed := time.Since(start).Milliseconds()
	_ = conn.Close()
	return elapsed
}

func pickIP(host, family string) net.IP {
	if ip := net.ParseIP(host); ip != nil {
		if (family == "v6") == (ip.To4() == nil) {
			return ip
		}
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return nil
	}
	for _, ip := range ips {
		if (family == "v6") == (ip.To4() == nil) {
			return ip
		}
	}
	return nil
}

// icmpPings 在一个 socket 上打 attempts 次 ICMP echo，返回 (成功次数, 累计耗时ms)
func icmpPings(host, family string) (int, int64) {
	network, listen, proto := "ip4:icmp", "0.0.0.0", 1
	if family == "v6" {
		network, listen, proto = "ip6:ipv6-icmp", "::", 58
	}

	dst := pickIP(host, family)
	if dst == nil {
		return 0, 0
	}

	conn, err := icmp.ListenPacket(network, listen)
	if err != nil {
		return 0, 0
	}
	defer conn.Close()

	id := os.Getpid() & 0xffff
	ok := 0
	var sum int64

	wantType := icmp.Type(ipv4.ICMPTypeEchoReply)
	reqType := icmp.Type(ipv4.ICMPTypeEcho)
	if family == "v6" {
		wantType = ipv6.ICMPTypeEchoReply
		reqType = ipv6.ICMPTypeEchoRequest
	}

	for i := 0; i < attempts; i++ {
		msg := icmp.Message{
			Type: reqType,
			Code: 0,
			Body: &icmp.Echo{ID: id, Seq: i, Data: []byte("incudal-probe")},
		}
		b, err := msg.Marshal(nil)
		if err != nil {
			continue
		}
		start := time.Now()
		if _, err := conn.WriteTo(b, &net.IPAddr{IP: dst}); err != nil {
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(timeout))
		buf := make([]byte, 1500)
		for {
			n, _, err := conn.ReadFrom(buf)
			if err != nil {
				break
			}
			rm, err := icmp.ParseMessage(proto, buf[:n])
			if err != nil || rm.Type != wantType {
				continue
			}
			if e, isEcho := rm.Body.(*icmp.Echo); isEcho && e.ID == id && e.Seq == i {
				sum += time.Since(start).Milliseconds()
				ok++
				break
			}
		}
	}
	return ok, sum
}

func runTarget(t Target) Result {
	res := Result{Key: t.Key, Samples: attempts}
	var sum int64
	ok := 0

	if t.Method == "icmp" {
		ok, sum = icmpPings(t.Host, t.Family)
	} else {
		for i := 0; i < attempts; i++ {
			if ms := tcpOnce(t.Host, t.Method); ms >= 0 {
				ok++
				sum += ms
			}
		}
	}

	res.LossPct = (attempts - ok) * 100 / attempts
	if ok > 0 {
		avg := float64(sum) / float64(ok)
		res.LatencyMs = &avg
	}
	return res
}

// Run 并发探测所有目标；families 里没有的协议族直接跳过
func Run(families map[string]bool) []Result {
	enabled := make([]Target, 0, len(targets))
	for _, t := range targets {
		if families[t.Family] {
			enabled = append(enabled, t)
		}
	}
	if len(enabled) == 0 {
		return nil
	}

	results := make([]Result, len(enabled))
	var wg sync.WaitGroup
	for i, t := range enabled {
		wg.Add(1)
		go func(idx int, tg Target) {
			defer wg.Done()
			results[idx] = runTarget(tg)
		}(i, t)
	}
	wg.Wait()
	return results
}

// RunAuto 自动探测本机支持的协议族
func RunAuto() []Result {
	families := map[string]bool{}
	if HasGlobalIPv4() {
		families["v4"] = true
	}
	if HasGlobalIPv6() {
		families["v6"] = true
	}
	if len(families) == 0 {
		families["v4"] = true
	}
	return Run(families)
}

// Families 返回本机支持的协议族（供上报用）
func Families() []string {
	out := []string{}
	if HasGlobalIPv4() {
		out = append(out, "v4")
	}
	if HasGlobalIPv6() {
		out = append(out, "v6")
	}
	return out
}

// Summary 把结果压成一行日志，方便排查
func Summary(results []Result) string {
	parts := make([]string, 0, len(results))
	for _, r := range results {
		if r.LatencyMs == nil {
			parts = append(parts, r.Key+"=超时")
		} else {
			parts = append(parts, r.Key+"="+strconv.FormatFloat(*r.LatencyMs, 'f', 0, 64)+"ms")
		}
	}
	return strings.Join(parts, " ")
}
