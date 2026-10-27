// Package probe 在节点本机对中国大陆三网节点做 TCP 连通性探测。
//
// 目标是一组按「城市-运营商-协议」划分的 CDN 探测点（zstaticcdn），
// 节点从自己所在的机房去连这些地址，得到「节点 → 中国大陆」的真实延迟与丢包，
// 这跟面板自己测节点是两回事（那个测的是面板 → 节点）。
package probe

import (
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Target 一个探测目标
type Target struct {
	Key    string // gd-cu-v4
	City   string // gd | sh
	ISP    string // cu | cm | ct
	Family string // v4 | v6
	Host   string
	Port   string
}

// Result 单个目标的探测结果
type Result struct {
	Key       string   `json:"key"`
	LatencyMs *float64 `json:"latencyMs"`
	LossPct   int      `json:"lossPct"`
	Samples   int      `json:"samples"`
}

var targets = []Target{
	// 广东
	{"gd-cu-v4", "gd", "cu", "v4", "gd-cu-v4.ip.zstaticcdn.com", "80"},
	{"gd-cm-v4", "gd", "cm", "v4", "gd-cm-v4.ip.zstaticcdn.com", "80"},
	{"gd-ct-v4", "gd", "ct", "v4", "gd-ct-v4.ip.zstaticcdn.com", "80"},
	{"gd-cu-v6", "gd", "cu", "v6", "gd-cu-v6.ip.zstaticcdn.com", "80"},
	{"gd-cm-v6", "gd", "cm", "v6", "gd-cm-v6.ip.zstaticcdn.com", "80"},
	{"gd-ct-v6", "gd", "ct", "v6", "gd-ct-v6.ip.zstaticcdn.com", "80"},
	// 上海
	{"sh-cu-v4", "sh", "cu", "v4", "sh-cu-v4.ip.zstaticcdn.com", "80"},
	{"sh-cm-v4", "sh", "cm", "v4", "sh-cm-v4.ip.zstaticcdn.com", "80"},
	{"sh-ct-v4", "sh", "ct", "v4", "sh-ct-v4.ip.zstaticcdn.com", "80"},
	{"sh-cu-v6", "sh", "cu", "v6", "sh-cu-v6.ip.zstaticcdn.com", "80"},
	{"sh-cm-v6", "sh", "cm", "v6", "sh-cm-v6.ip.zstaticcdn.com", "80"},
	{"sh-ct-v6", "sh", "ct", "v6", "sh-ct-v6.ip.zstaticcdn.com", "80"},
	// 出站自检：国内站点 + 国际站点各一个，用来判断「节点根本出不去」还是「到国内线路不通」
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

func runTarget(t Target) Result {
	res := Result{Key: t.Key, Samples: attempts}
	var sum int64
	ok := 0
	for i := 0; i < attempts; i++ {
		if ms := tcpOnce(t.Host, t.Port); ms >= 0 {
			ok++
			sum += ms
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
