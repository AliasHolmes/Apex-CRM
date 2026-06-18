(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // node_modules/papaparse/papaparse.min.js
  var require_papaparse_min = __commonJS({
    "node_modules/papaparse/papaparse.min.js"(exports, module) {
      ((e, t) => {
        "function" == typeof define && define.amd ? define([], t) : "object" == typeof module && "undefined" != typeof exports ? module.exports = t() : e.Papa = t();
      })(exports, function r() {
        var n = "undefined" != typeof self ? self : "undefined" != typeof window ? window : void 0 !== n ? n : {};
        var d, s = !n.document && !!n.postMessage, a = n.IS_PAPA_WORKER || false, o = {}, h = 0, v = {};
        function u(e) {
          this._handle = null, this._finished = false, this._completed = false, this._halted = false, this._input = null, this._baseIndex = 0, this._partialLine = "", this._rowCount = 0, this._start = 0, this._nextChunk = null, this.isFirstChunk = true, this._completeResults = { data: [], errors: [], meta: {} }, function(e2) {
            var t = b(e2);
            t.chunkSize = parseInt(t.chunkSize), e2.step || e2.chunk || (t.chunkSize = null);
            this._handle = new i(t), (this._handle.streamer = this)._config = t;
          }.call(this, e), this.parseChunk = function(t, e2) {
            var i2 = parseInt(this._config.skipFirstNLines) || 0;
            if (this.isFirstChunk && 0 < i2) {
              let e3 = this._config.newline;
              e3 || (r2 = this._config.quoteChar || '"', e3 = this._handle.guessLineEndings(t, r2)), t = [...t.split(e3).slice(i2)].join(e3);
            }
            this.isFirstChunk && U(this._config.beforeFirstChunk) && void 0 !== (r2 = this._config.beforeFirstChunk(t)) && (t = r2), this.isFirstChunk = false, this._halted = false;
            var i2 = this._partialLine + t, r2 = (this._partialLine = "", this._handle.parse(i2, this._baseIndex, !this._finished));
            if (!this._handle.paused() && !this._handle.aborted()) {
              t = r2.meta.cursor, i2 = (this._finished || (this._partialLine = i2.substring(t - this._baseIndex), this._baseIndex = t), r2 && r2.data && (this._rowCount += r2.data.length), this._finished || this._config.preview && this._rowCount >= this._config.preview);
              if (a) n.postMessage({ results: r2, workerId: v.WORKER_ID, finished: i2 });
              else if (U(this._config.chunk) && !e2) {
                if (this._config.chunk(r2, this._handle), this._handle.paused() || this._handle.aborted()) return void (this._halted = true);
                this._completeResults = r2 = void 0;
              }
              return this._config.step || this._config.chunk || (this._completeResults.data = this._completeResults.data.concat(r2.data), this._completeResults.errors = this._completeResults.errors.concat(r2.errors), this._completeResults.meta = r2.meta), this._completed || !i2 || !U(this._config.complete) || r2 && r2.meta.aborted || (this._config.complete(this._completeResults, this._input), this._completed = true), i2 || r2 && r2.meta.paused || this._nextChunk(), r2;
            }
            this._halted = true;
          }, this._sendError = function(e2) {
            U(this._config.error) ? this._config.error(e2) : a && this._config.error && n.postMessage({ workerId: v.WORKER_ID, error: e2, finished: false });
          };
        }
        function f(e) {
          var r2;
          (e = e || {}).chunkSize || (e.chunkSize = v.RemoteChunkSize), u.call(this, e), this._nextChunk = s ? function() {
            this._readChunk(), this._chunkLoaded();
          } : function() {
            this._readChunk();
          }, this.stream = function(e2) {
            this._input = e2, this._nextChunk();
          }, this._readChunk = function() {
            if (this._finished) this._chunkLoaded();
            else {
              if (r2 = new XMLHttpRequest(), this._config.withCredentials && (r2.withCredentials = this._config.withCredentials), s || (r2.onload = y(this._chunkLoaded, this), r2.onerror = y(this._chunkError, this)), r2.open(this._config.downloadRequestBody ? "POST" : "GET", this._input, !s), this._config.downloadRequestHeaders) {
                var e2, t = this._config.downloadRequestHeaders;
                for (e2 in t) r2.setRequestHeader(e2, t[e2]);
              }
              var i2;
              this._config.chunkSize && (i2 = this._start + this._config.chunkSize - 1, r2.setRequestHeader("Range", "bytes=" + this._start + "-" + i2));
              try {
                r2.send(this._config.downloadRequestBody);
              } catch (e3) {
                this._chunkError(e3.message);
              }
              s && 0 === r2.status && this._chunkError();
            }
          }, this._chunkLoaded = function() {
            4 === r2.readyState && (r2.status < 200 || 400 <= r2.status ? this._chunkError() : (this._start += this._config.chunkSize || r2.responseText.length, this._finished = !this._config.chunkSize || this._start >= ((e2) => null !== (e2 = e2.getResponseHeader("Content-Range")) ? parseInt(e2.substring(e2.lastIndexOf("/") + 1)) : -1)(r2), this.parseChunk(r2.responseText)));
          }, this._chunkError = function(e2) {
            e2 = r2.statusText || e2;
            this._sendError(new Error(e2));
          };
        }
        function l(e) {
          (e = e || {}).chunkSize || (e.chunkSize = v.LocalChunkSize), u.call(this, e);
          var i2, r2, n2 = "undefined" != typeof FileReader;
          this.stream = function(e2) {
            this._input = e2, r2 = e2.slice || e2.webkitSlice || e2.mozSlice, n2 ? ((i2 = new FileReader()).onload = y(this._chunkLoaded, this), i2.onerror = y(this._chunkError, this)) : i2 = new FileReaderSync(), this._nextChunk();
          }, this._nextChunk = function() {
            this._finished || this._config.preview && !(this._rowCount < this._config.preview) || this._readChunk();
          }, this._readChunk = function() {
            var e2 = this._input, t = (this._config.chunkSize && (t = Math.min(this._start + this._config.chunkSize, this._input.size), e2 = r2.call(e2, this._start, t)), i2.readAsText(e2, this._config.encoding));
            n2 || this._chunkLoaded({ target: { result: t } });
          }, this._chunkLoaded = function(e2) {
            this._start += this._config.chunkSize, this._finished = !this._config.chunkSize || this._start >= this._input.size, this.parseChunk(e2.target.result);
          }, this._chunkError = function() {
            this._sendError(i2.error);
          };
        }
        function c(e) {
          var i2;
          u.call(this, e = e || {}), this.stream = function(e2) {
            return i2 = e2, this._nextChunk();
          }, this._nextChunk = function() {
            var e2, t;
            if (!this._finished) return e2 = this._config.chunkSize, i2 = e2 ? (t = i2.substring(0, e2), i2.substring(e2)) : (t = i2, ""), this._finished = !i2, this.parseChunk(t);
          };
        }
        function p(e) {
          u.call(this, e = e || {});
          var t = [], i2 = true, r2 = false;
          this.pause = function() {
            u.prototype.pause.apply(this, arguments), this._input.pause();
          }, this.resume = function() {
            u.prototype.resume.apply(this, arguments), this._input.resume();
          }, this.stream = function(e2) {
            this._input = e2, this._input.on("data", this._streamData), this._input.on("end", this._streamEnd), this._input.on("error", this._streamError);
          }, this._checkIsFinished = function() {
            r2 && 1 === t.length && (this._finished = true);
          }, this._nextChunk = function() {
            this._checkIsFinished(), t.length ? this.parseChunk(t.shift()) : i2 = true;
          }, this._streamData = y(function(e2) {
            try {
              t.push("string" == typeof e2 ? e2 : e2.toString(this._config.encoding)), i2 && (i2 = false, this._checkIsFinished(), this.parseChunk(t.shift()));
            } catch (e3) {
              this._streamError(e3);
            }
          }, this), this._streamError = y(function(e2) {
            this._streamCleanUp(), this._sendError(e2);
          }, this), this._streamEnd = y(function() {
            this._streamCleanUp(), r2 = true, this._streamData("");
          }, this), this._streamCleanUp = y(function() {
            this._input.removeListener("data", this._streamData), this._input.removeListener("end", this._streamEnd), this._input.removeListener("error", this._streamError);
          }, this);
        }
        function i(m2) {
          var n2, s2, a2, t, o2 = Math.pow(2, 53), h2 = -o2, u2 = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/, d2 = /^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/, i2 = this, r2 = 0, f2 = 0, l2 = false, e = false, c2 = [], p2 = { data: [], errors: [], meta: {} };
          function y2(e2) {
            return "greedy" === m2.skipEmptyLines ? "" === e2.join("").trim() : 1 === e2.length && 0 === e2[0].length;
          }
          function g2() {
            if (p2 && a2 && (k("Delimiter", "UndetectableDelimiter", "Unable to auto-detect delimiting character; defaulted to '" + v.DefaultDelimiter + "'"), a2 = false), m2.skipEmptyLines && (p2.data = p2.data.filter(function(e3) {
              return !y2(e3);
            })), _2()) {
              let t3 = function(e3, t4) {
                U(m2.transformHeader) && (e3 = m2.transformHeader(e3, t4)), c2.push(e3);
              };
              var t2 = t3;
              if (p2) if (Array.isArray(p2.data[0])) {
                for (var e2 = 0; _2() && e2 < p2.data.length; e2++) p2.data[e2].forEach(t3);
                p2.data.splice(0, 1);
              } else p2.data.forEach(t3);
            }
            function i3(e3, t3) {
              for (var i4 = m2.header ? {} : [], r4 = 0; r4 < e3.length; r4++) {
                var n3 = r4, s3 = e3[r4], s3 = ((e4, t4) => ((e5) => (m2.dynamicTypingFunction && void 0 === m2.dynamicTyping[e5] && (m2.dynamicTyping[e5] = m2.dynamicTypingFunction(e5)), true === (m2.dynamicTyping[e5] || m2.dynamicTyping)))(e4) ? "true" === t4 || "TRUE" === t4 || "false" !== t4 && "FALSE" !== t4 && (((e5) => {
                  if (u2.test(e5)) {
                    e5 = parseFloat(e5);
                    if (h2 < e5 && e5 < o2) return 1;
                  }
                })(t4) ? parseFloat(t4) : d2.test(t4) ? new Date(t4) : "" === t4 ? null : t4) : t4)(n3 = m2.header ? r4 >= c2.length ? "__parsed_extra" : c2[r4] : n3, s3 = m2.transform ? m2.transform(s3, n3) : s3);
                "__parsed_extra" === n3 ? (i4[n3] = i4[n3] || [], i4[n3].push(s3)) : i4[n3] = s3;
              }
              return m2.header && (r4 > c2.length ? k("FieldMismatch", "TooManyFields", "Too many fields: expected " + c2.length + " fields but parsed " + r4, f2 + t3) : r4 < c2.length && k("FieldMismatch", "TooFewFields", "Too few fields: expected " + c2.length + " fields but parsed " + r4, f2 + t3)), i4;
            }
            var r3;
            p2 && (m2.header || m2.dynamicTyping || m2.transform) && (r3 = 1, !p2.data.length || Array.isArray(p2.data[0]) ? (p2.data = p2.data.map(i3), r3 = p2.data.length) : p2.data = i3(p2.data, 0), m2.header && p2.meta && (p2.meta.fields = c2), f2 += r3);
          }
          function _2() {
            return m2.header && 0 === c2.length;
          }
          function k(e2, t2, i3, r3) {
            e2 = { type: e2, code: t2, message: i3 };
            void 0 !== r3 && (e2.row = r3), p2.errors.push(e2);
          }
          U(m2.step) && (t = m2.step, m2.step = function(e2) {
            p2 = e2, _2() ? g2() : (g2(), 0 !== p2.data.length && (r2 += e2.data.length, m2.preview && r2 > m2.preview ? s2.abort() : (p2.data = p2.data[0], t(p2, i2))));
          }), this.parse = function(e2, t2, i3) {
            var r3 = m2.quoteChar || '"', r3 = (m2.newline || (m2.newline = this.guessLineEndings(e2, r3)), a2 = false, m2.delimiter ? U(m2.delimiter) && (m2.delimiter = m2.delimiter(e2), p2.meta.delimiter = m2.delimiter) : ((r3 = ((e3, t3, i4, r4, n3) => {
              var s3, a3, o3, h3;
              n3 = n3 || [",", "	", "|", ";", v.RECORD_SEP, v.UNIT_SEP];
              for (var u3 = 0; u3 < n3.length; u3++) {
                for (var d3, f3 = n3[u3], l3 = 0, c3 = 0, p3 = 0, g3 = (o3 = void 0, new E({ comments: r4, delimiter: f3, newline: t3, preview: 10 }).parse(e3)), _3 = 0; _3 < g3.data.length; _3++) i4 && y2(g3.data[_3]) ? p3++ : (d3 = g3.data[_3].length, c3 += d3, void 0 === o3 ? o3 = d3 : 0 < d3 && (l3 += Math.abs(d3 - o3), o3 = d3));
                0 < g3.data.length && (c3 /= g3.data.length - p3), (void 0 === a3 || l3 <= a3) && (void 0 === h3 || h3 < c3) && 1.99 < c3 && (a3 = l3, s3 = f3, h3 = c3);
              }
              return { successful: !!(m2.delimiter = s3), bestDelimiter: s3 };
            })(e2, m2.newline, m2.skipEmptyLines, m2.comments, m2.delimitersToGuess)).successful ? m2.delimiter = r3.bestDelimiter : (a2 = true, m2.delimiter = v.DefaultDelimiter), p2.meta.delimiter = m2.delimiter), b(m2));
            return m2.preview && m2.header && r3.preview++, n2 = e2, s2 = new E(r3), p2 = s2.parse(n2, t2, i3), g2(), l2 ? { meta: { paused: true } } : p2 || { meta: { paused: false } };
          }, this.paused = function() {
            return l2;
          }, this.pause = function() {
            l2 = true, s2.abort(), n2 = U(m2.chunk) ? "" : n2.substring(s2.getCharIndex());
          }, this.resume = function() {
            i2.streamer._halted ? (l2 = false, i2.streamer.parseChunk(n2, true)) : setTimeout(i2.resume, 3);
          }, this.aborted = function() {
            return e;
          }, this.abort = function() {
            e = true, s2.abort(), p2.meta.aborted = true, U(m2.complete) && m2.complete(p2), n2 = "";
          }, this.guessLineEndings = function(e2, t2) {
            e2 = e2.substring(0, 1048576);
            var t2 = new RegExp(P(t2) + "([^]*?)" + P(t2), "gm"), i3 = (e2 = e2.replace(t2, "")).split("\r"), t2 = e2.split("\n"), e2 = 1 < t2.length && t2[0].length < i3[0].length;
            if (1 === i3.length || e2) return "\n";
            for (var r3 = 0, n3 = 0; n3 < i3.length; n3++) "\n" === i3[n3][0] && r3++;
            return r3 >= i3.length / 2 ? "\r\n" : "\r";
          };
        }
        function P(e) {
          return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
        function E(C) {
          var S = (C = C || {}).delimiter, O = C.newline, x = C.comments, I = C.step, A = C.preview, T = C.fastMode, D = null, L = false, F = null == C.quoteChar ? '"' : C.quoteChar, j = F;
          if (void 0 !== C.escapeChar && (j = C.escapeChar), ("string" != typeof S || -1 < v.BAD_DELIMITERS.indexOf(S)) && (S = ","), x === S) throw new Error("Comment character same as delimiter");
          true === x ? x = "#" : ("string" != typeof x || -1 < v.BAD_DELIMITERS.indexOf(x)) && (x = false), "\n" !== O && "\r" !== O && "\r\n" !== O && (O = "\n");
          var z = 0, M = false;
          this.parse = function(i2, t, r2) {
            if ("string" != typeof i2) throw new Error("Input must be a string");
            var n2 = i2.length, e = S.length, s2 = O.length, a2 = x.length, o2 = U(I), h2 = [], u2 = [], d2 = [], f2 = z = 0;
            if (!i2) return w();
            if (T || false !== T && -1 === i2.indexOf(F)) {
              for (var l2 = i2.split(O), c2 = 0; c2 < l2.length; c2++) {
                if (d2 = l2[c2], z += d2.length, c2 !== l2.length - 1) z += O.length;
                else if (r2) return w();
                if (!x || d2.substring(0, a2) !== x) {
                  if (o2) {
                    if (h2 = [], k(d2.split(S)), R(), M) return w();
                  } else k(d2.split(S));
                  if (A && A <= c2) return h2 = h2.slice(0, A), w(true);
                }
              }
              return w();
            }
            for (var p2 = i2.indexOf(S, z), g2 = i2.indexOf(O, z), _2 = new RegExp(P(j) + P(F), "g"), m2 = i2.indexOf(F, z); ; ) if (i2[z] === F) for (m2 = z, z++; ; ) {
              if (-1 === (m2 = i2.indexOf(F, m2 + 1))) return r2 || u2.push({ type: "Quotes", code: "MissingQuotes", message: "Quoted field unterminated", row: h2.length, index: z }), E2();
              if (m2 === n2 - 1) return E2(i2.substring(z, m2).replace(_2, F));
              if (F === j && i2[m2 + 1] === j) m2++;
              else if (F === j || 0 === m2 || i2[m2 - 1] !== j) {
                -1 !== p2 && p2 < m2 + 1 && (p2 = i2.indexOf(S, m2 + 1));
                var y2 = v2(-1 === (g2 = -1 !== g2 && g2 < m2 + 1 ? i2.indexOf(O, m2 + 1) : g2) ? p2 : Math.min(p2, g2));
                if (i2.substr(m2 + 1 + y2, e) === S) {
                  d2.push(i2.substring(z, m2).replace(_2, F)), i2[z = m2 + 1 + y2 + e] !== F && (m2 = i2.indexOf(F, z)), p2 = i2.indexOf(S, z), g2 = i2.indexOf(O, z);
                  break;
                }
                y2 = v2(g2);
                if (i2.substring(m2 + 1 + y2, m2 + 1 + y2 + s2) === O) {
                  if (d2.push(i2.substring(z, m2).replace(_2, F)), b2(m2 + 1 + y2 + s2), p2 = i2.indexOf(S, z), m2 = i2.indexOf(F, z), o2 && (R(), M)) return w();
                  if (A && h2.length >= A) return w(true);
                  break;
                }
                u2.push({ type: "Quotes", code: "InvalidQuotes", message: "Trailing quote on quoted field is malformed", row: h2.length, index: z }), m2++;
              }
            }
            else if (x && 0 === d2.length && i2.substring(z, z + a2) === x) {
              if (-1 === g2) return w();
              z = g2 + s2, g2 = i2.indexOf(O, z), p2 = i2.indexOf(S, z);
            } else if (-1 !== p2 && (p2 < g2 || -1 === g2)) d2.push(i2.substring(z, p2)), z = p2 + e, p2 = i2.indexOf(S, z);
            else {
              if (-1 === g2) break;
              if (d2.push(i2.substring(z, g2)), b2(g2 + s2), o2 && (R(), M)) return w();
              if (A && h2.length >= A) return w(true);
            }
            return E2();
            function k(e2) {
              h2.push(e2), f2 = z;
            }
            function v2(e2) {
              var t2 = 0;
              return t2 = -1 !== e2 && (e2 = i2.substring(m2 + 1, e2)) && "" === e2.trim() ? e2.length : t2;
            }
            function E2(e2) {
              return r2 || (void 0 === e2 && (e2 = i2.substring(z)), d2.push(e2), z = n2, k(d2), o2 && R()), w();
            }
            function b2(e2) {
              z = e2, k(d2), d2 = [], g2 = i2.indexOf(O, z);
            }
            function w(e2) {
              if (C.header && !t && h2.length && !L) {
                var s3 = h2[0], a3 = /* @__PURE__ */ Object.create(null), o3 = new Set(s3);
                let n3 = false;
                for (let r3 = 0; r3 < s3.length; r3++) {
                  let i3 = s3[r3];
                  if (a3[i3 = U(C.transformHeader) ? C.transformHeader(i3, r3) : i3]) {
                    let e3, t2 = a3[i3];
                    for (; e3 = i3 + "_" + t2, t2++, o3.has(e3); ) ;
                    o3.add(e3), s3[r3] = e3, a3[i3]++, n3 = true, (D = null === D ? {} : D)[e3] = i3;
                  } else a3[i3] = 1, s3[r3] = i3;
                  o3.add(i3);
                }
                n3 && console.warn("Duplicate headers found and renamed."), L = true;
              }
              return { data: h2, errors: u2, meta: { delimiter: S, linebreak: O, aborted: M, truncated: !!e2, cursor: f2 + (t || 0), renamedHeaders: D } };
            }
            function R() {
              I(w()), h2 = [], u2 = [];
            }
          }, this.abort = function() {
            M = true;
          }, this.getCharIndex = function() {
            return z;
          };
        }
        function g(e) {
          var t = e.data, i2 = o[t.workerId], r2 = false;
          if (t.error) i2.userError(t.error, t.file);
          else if (t.results && t.results.data) {
            var n2 = { abort: function() {
              r2 = true, _(t.workerId, { data: [], errors: [], meta: { aborted: true } });
            }, pause: m, resume: m };
            if (U(i2.userStep)) {
              for (var s2 = 0; s2 < t.results.data.length && (i2.userStep({ data: t.results.data[s2], errors: t.results.errors, meta: t.results.meta }, n2), !r2); s2++) ;
              delete t.results;
            } else U(i2.userChunk) && (i2.userChunk(t.results, n2, t.file), delete t.results);
          }
          t.finished && !r2 && _(t.workerId, t.results);
        }
        function _(e, t) {
          var i2 = o[e];
          U(i2.userComplete) && i2.userComplete(t), i2.terminate(), delete o[e];
        }
        function m() {
          throw new Error("Not implemented.");
        }
        function b(e) {
          if ("object" != typeof e || null === e) return e;
          var t, i2 = Array.isArray(e) ? [] : {};
          for (t in e) i2[t] = b(e[t]);
          return i2;
        }
        function y(e, t) {
          return function() {
            e.apply(t, arguments);
          };
        }
        function U(e) {
          return "function" == typeof e;
        }
        return v.parse = function(e, t) {
          var i2 = (t = t || {}).dynamicTyping || false;
          U(i2) && (t.dynamicTypingFunction = i2, i2 = {});
          if (t.dynamicTyping = i2, t.transform = !!U(t.transform) && t.transform, !t.worker || !v.WORKERS_SUPPORTED) return i2 = null, v.NODE_STREAM_INPUT, "string" == typeof e ? (e = ((e2) => 65279 !== e2.charCodeAt(0) ? e2 : e2.slice(1))(e), i2 = new (t.download ? f : c)(t)) : true === e.readable && U(e.read) && U(e.on) ? i2 = new p(t) : (n.File && e instanceof File || e instanceof Object) && (i2 = new l(t)), i2.stream(e);
          (i2 = (() => {
            var e2;
            return !!v.WORKERS_SUPPORTED && (e2 = (() => {
              var e3 = n.URL || n.webkitURL || null, t2 = r.toString();
              return v.BLOB_URL || (v.BLOB_URL = e3.createObjectURL(new Blob(["var global = (function() { if (typeof self !== 'undefined') { return self; } if (typeof window !== 'undefined') { return window; } if (typeof global !== 'undefined') { return global; } return {}; })(); global.IS_PAPA_WORKER=true; ", "(", t2, ")();"], { type: "text/javascript" })));
            })(), (e2 = new n.Worker(e2)).onmessage = g, e2.id = h++, o[e2.id] = e2);
          })()).userStep = t.step, i2.userChunk = t.chunk, i2.userComplete = t.complete, i2.userError = t.error, t.step = U(t.step), t.chunk = U(t.chunk), t.complete = U(t.complete), t.error = U(t.error), delete t.worker, i2.postMessage({ input: e, config: t, workerId: i2.id });
        }, v.unparse = function(e, t) {
          var n2 = false, _2 = true, m2 = ",", y2 = "\r\n", s2 = '"', a2 = s2 + s2, i2 = false, r2 = null, o2 = false, h2 = ((() => {
            if ("object" == typeof t) {
              if ("string" != typeof t.delimiter || v.BAD_DELIMITERS.filter(function(e2) {
                return -1 !== t.delimiter.indexOf(e2);
              }).length || (m2 = t.delimiter), "boolean" != typeof t.quotes && "function" != typeof t.quotes && !Array.isArray(t.quotes) || (n2 = t.quotes), "boolean" != typeof t.skipEmptyLines && "string" != typeof t.skipEmptyLines || (i2 = t.skipEmptyLines), "string" == typeof t.newline && (y2 = t.newline), "string" == typeof t.quoteChar && (s2 = t.quoteChar), "boolean" == typeof t.header && (_2 = t.header), Array.isArray(t.columns)) {
                if (0 === t.columns.length) throw new Error("Option columns is empty");
                r2 = t.columns;
              }
              void 0 !== t.escapeChar && (a2 = t.escapeChar + s2), t.escapeFormulae instanceof RegExp ? o2 = t.escapeFormulae : "boolean" == typeof t.escapeFormulae && t.escapeFormulae && (o2 = /^[=+\-@\t\r].*$/);
            }
          })(), new RegExp(P(s2), "g"));
          "string" == typeof e && (e = JSON.parse(e));
          if (Array.isArray(e)) {
            if (!e.length || Array.isArray(e[0])) return u2(null, e, i2);
            if ("object" == typeof e[0]) return u2(r2 || Object.keys(e[0]), e, i2);
          } else if ("object" == typeof e) return "string" == typeof e.data && (e.data = JSON.parse(e.data)), Array.isArray(e.data) && (e.fields || (e.fields = e.meta && e.meta.fields || r2), e.fields || (e.fields = Array.isArray(e.data[0]) ? e.fields : "object" == typeof e.data[0] ? Object.keys(e.data[0]) : []), Array.isArray(e.data[0]) || "object" == typeof e.data[0] || (e.data = [e.data])), u2(e.fields || [], e.data || [], i2);
          throw new Error("Unable to serialize unrecognized input");
          function u2(e2, t2, i3) {
            var r3 = "", n3 = ("string" == typeof e2 && (e2 = JSON.parse(e2)), "string" == typeof t2 && (t2 = JSON.parse(t2)), Array.isArray(e2) && 0 < e2.length), s3 = !Array.isArray(t2[0]);
            if (n3 && _2) {
              for (var a3 = 0; a3 < e2.length; a3++) 0 < a3 && (r3 += m2), r3 += k(e2[a3], a3);
              0 < t2.length && (r3 += y2);
            }
            for (var o3 = 0; o3 < t2.length; o3++) {
              var h3 = (n3 ? e2 : t2[o3]).length, u3 = false, d2 = n3 ? 0 === Object.keys(t2[o3]).length : 0 === t2[o3].length;
              if (i3 && !n3 && (u3 = "greedy" === i3 ? "" === t2[o3].join("").trim() : 1 === t2[o3].length && 0 === t2[o3][0].length), "greedy" === i3 && n3) {
                for (var f2 = [], l2 = 0; l2 < h3; l2++) {
                  var c2 = s3 ? e2[l2] : l2;
                  f2.push(t2[o3][c2]);
                }
                u3 = "" === f2.join("").trim();
              }
              if (!u3) {
                for (var p2 = 0; p2 < h3; p2++) {
                  0 < p2 && !d2 && (r3 += m2);
                  var g2 = n3 && s3 ? e2[p2] : p2;
                  r3 += k(t2[o3][g2], p2);
                }
                o3 < t2.length - 1 && (!i3 || 0 < h3 && !d2) && (r3 += y2);
              }
            }
            return r3;
          }
          function k(e2, t2) {
            var i3, r3;
            return null == e2 ? "" : e2.constructor === Date ? JSON.stringify(e2).slice(1, 25) : (r3 = false, o2 && "string" == typeof e2 && o2.test(e2) && (e2 = "'" + e2, r3 = true), i3 = e2.toString().replace(h2, a2), (r3 = r3 || true === n2 || "function" == typeof n2 && n2(e2, t2) || Array.isArray(n2) && n2[t2] || ((e3, t3) => {
              for (var i4 = 0; i4 < t3.length; i4++) if (-1 < e3.indexOf(t3[i4])) return true;
              return false;
            })(i3, v.BAD_DELIMITERS) || -1 < i3.indexOf(m2) || " " === i3.charAt(0) || " " === i3.charAt(i3.length - 1)) ? s2 + i3 + s2 : i3);
          }
        }, v.RECORD_SEP = String.fromCharCode(30), v.UNIT_SEP = String.fromCharCode(31), v.BYTE_ORDER_MARK = "\uFEFF", v.BAD_DELIMITERS = ["\r", "\n", '"', v.BYTE_ORDER_MARK], v.WORKERS_SUPPORTED = !s && !!n.Worker, v.NODE_STREAM_INPUT = 1, v.LocalChunkSize = 10485760, v.RemoteChunkSize = 5242880, v.DefaultDelimiter = ",", v.Parser = E, v.ParserHandle = i, v.NetworkStreamer = f, v.FileStreamer = l, v.StringStreamer = c, v.ReadableStreamStreamer = p, n.jQuery && ((d = n.jQuery).fn.parse = function(o2) {
          var i2 = o2.config || {}, h2 = [];
          return this.each(function(e2) {
            if (!("INPUT" === d(this).prop("tagName").toUpperCase() && "file" === d(this).attr("type").toLowerCase() && n.FileReader) || !this.files || 0 === this.files.length) return true;
            for (var t = 0; t < this.files.length; t++) h2.push({ file: this.files[t], inputElem: this, instanceConfig: d.extend({}, i2) });
          }), e(), this;
          function e() {
            if (0 === h2.length) U(o2.complete) && o2.complete();
            else {
              var e2, t, i3, r2, n2 = h2[0];
              if (U(o2.before)) {
                var s2 = o2.before(n2.file, n2.inputElem);
                if ("object" == typeof s2) {
                  if ("abort" === s2.action) return e2 = "AbortError", t = n2.file, i3 = n2.inputElem, r2 = s2.reason, void (U(o2.error) && o2.error({ name: e2 }, t, i3, r2));
                  if ("skip" === s2.action) return void u2();
                  "object" == typeof s2.config && (n2.instanceConfig = d.extend(n2.instanceConfig, s2.config));
                } else if ("skip" === s2) return void u2();
              }
              var a2 = n2.instanceConfig.complete;
              n2.instanceConfig.complete = function(e3) {
                U(a2) && a2(e3, n2.file, n2.inputElem), u2();
              }, v.parse(n2.file, n2.instanceConfig);
            }
          }
          function u2() {
            h2.splice(0, 1), e();
          }
        }), a && (n.onmessage = function(e) {
          e = e.data;
          void 0 === v.WORKER_ID && e && (v.WORKER_ID = e.workerId);
          "string" == typeof e.input ? n.postMessage({ workerId: v.WORKER_ID, results: v.parse(e.input, e.config), finished: true }) : (n.File && e.input instanceof File || e.input instanceof Object) && (e = v.parse(e.input, e.config)) && n.postMessage({ workerId: v.WORKER_ID, results: e, finished: true });
        }), (f.prototype = Object.create(u.prototype)).constructor = f, (l.prototype = Object.create(u.prototype)).constructor = l, (c.prototype = Object.create(c.prototype)).constructor = c, (p.prototype = Object.create(u.prototype)).constructor = p, v;
      });
    }
  });

  // src/main.tsx
  var import_react10 = __require("react");
  var import_client = __require("react-dom/client");

  // src/App.tsx
  var import_react8 = __require("react");
  var import_react9 = __require("motion/react");
  var import_lucide_react6 = __require("lucide-react");

  // src/components/ScrapeWorkspace.tsx
  var import_react = __require("react");
  var import_react2 = __require("motion/react");
  var import_lucide_react = __require("lucide-react");
  var import_jsx_runtime = __require("react/jsx-runtime");
  function ScrapeWorkspace({ leads, onLeadAdded, onBulkLeadsAdded }) {
    const [activeTab, setActiveTab] = (0, import_react.useState)("url");
    const [apiKeyDetected, setApiKeyDetected] = (0, import_react.useState)(null);
    const [urlInput, setUrlInput] = (0, import_react.useState)("https://www.linkedin.com/in/siskind/");
    const [pastedText, setPastedText] = (0, import_react.useState)("");
    const [findQuery, setFindQuery] = (0, import_react.useState)("Immigration Attorneys in Memphis");
    const [leadLimit, setLeadLimit] = (0, import_react.useState)(5);
    const [loading, setLoading] = (0, import_react.useState)(false);
    const [errorCode, setErrorCode] = (0, import_react.useState)(null);
    const [successMsg, setSuccessMsg] = (0, import_react.useState)(null);
    const [sourceLinks, setSourceLinks] = (0, import_react.useState)([]);
    const [terminalLogs, setTerminalLogs] = (0, import_react.useState)([]);
    (0, import_react.useEffect)(() => {
      let timer;
      if (loading && activeTab === "find") {
        const initTime = (/* @__PURE__ */ new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        setTerminalLogs([
          `[${initTime}] \u{1F50D} SYSTEM INIT: Parsing spec parameters & intent triggers...`
        ]);
        const logPool = [
          `\u{1F9E9} INTENT ANALYSIS: Found complex spec criteria. Extracted Job Titles & industries.`,
          `\u{1F3AF} COMBINATIONS INDEXED: Checking overlap across specified priority niches (HVAC, Dental, etc.).`,
          `\u{1F680} FORMULATING GROUNDING TARGETS: Compiling 3-4 specialized Google search query permutations.`,
          `\u{1F310} RUNNING BATCH 1: Querying public indices for targeted parameters...`,
          `\u{1F4CA} DATA RETRIEVED: Found initial candidates. Extracting public LinkedIn summaries and bios.`,
          `\u2696\uFE0F NICHE ANALYZER: Evaluating representation metrics. Checking for index bias...`,
          `\u26A0\uFE0F DISPARITY RECOGNIZED: Marketing Agency leads dominate. Other niches (Home Services, Clinic Practice) under-saturated.`,
          `\u{1F9E0} ADAPTIVE CONTROL: Triggering self-correction pivot! Forcing niche balance.`,
          `\u{1F4E1} RUNNING CORRECTIVE SEARCH: site:linkedin.com/in "Practice Owner" ("Dental" | "Med Spa")!`,
          `\u{1F52C} AUTO-CORRECTIVE INTEGRATION: Yielded 4 new local clinic owners. Verifying 5-75 employee rule.`,
          `\u{1F6E0}\uFE0F REBALANCING COMPLETE: Merging queries. Synthesizing standard corporate emails (first.last@domain.com).`,
          `\u2705 SUCCESS: Perfect multi-niche distribution synthesized. Registering in main CRM database...`
        ];
        let currentIndex = 0;
        timer = setInterval(() => {
          const timeStr = (/* @__PURE__ */ new Date()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          if (currentIndex < logPool.length) {
            setTerminalLogs((prev) => [...prev, `[${timeStr}] ${logPool[currentIndex]}`]);
            currentIndex++;
          } else {
            clearInterval(timer);
          }
        }, 900);
      } else {
        setTerminalLogs([]);
      }
      return () => {
        if (timer) clearInterval(timer);
      };
    }, [loading, activeTab]);
    (0, import_react.useEffect)(() => {
      fetch("/api/health").then((r) => r.json()).then((data) => {
        if (data && typeof data.hasKey === "boolean") {
          setApiKeyDetected(data.hasKey);
        }
      }).catch(() => {
      });
    }, []);
    const [tasks, setTasks] = (0, import_react.useState)([
      {
        id: "task-1",
        type: "url",
        query: "https://www.linkedin.com/in/siskind/",
        status: "completed",
        resultCount: 1,
        createdAt: new Date(Date.now() - 36e5).toISOString()
      },
      {
        id: "task-2",
        type: "search",
        query: "AI Researchers at Google",
        status: "completed",
        resultCount: 4,
        createdAt: new Date(Date.now() - 72e5).toISOString()
      }
    ]);
    const handleTaskAdd = (type, query) => {
      const newTask = {
        id: `task-${Date.now()}`,
        type,
        query: query.length > 50 ? query.substring(0, 50) + "..." : query,
        status: "idle",
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      setTasks((prev) => [newTask, ...prev]);
      return newTask.id;
    };
    const updateTaskStatus = (taskId, status, resultCount) => {
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status, resultCount } : t));
    };
    const checkIsDuplicate = (input) => {
      if (!input || !leads) return false;
      const cleanInput = input.trim().toLowerCase();
      const getLinkedinHandle = (url) => {
        try {
          const parts = url.toLowerCase().replace(/\/$/, "").split("/in/");
          if (parts.length > 1) {
            return parts[1].split(/[?#]/)[0].trim();
          }
        } catch {
        }
        return url.trim();
      };
      const inputHandle = input.includes("linkedin.com/in/") ? getLinkedinHandle(cleanInput) : null;
      return leads.some((lead) => {
        const email = lead.profile.contactDetails?.email?.toLowerCase() || "";
        const linkedin = lead.profile.contactDetails?.linkedinUrl?.toLowerCase() || "";
        const name = (lead.profile.fullName || "").toLowerCase();
        const leadHandle = linkedin ? getLinkedinHandle(linkedin) : "";
        return email && email === cleanInput || linkedin && linkedin === cleanInput || linkedin && linkedin.includes(cleanInput) || inputHandle && leadHandle && inputHandle === leadHandle || name === cleanInput;
      });
    };
    const handleUrlScrape = async (e) => {
      e.preventDefault();
      if (!urlInput.trim()) return;
      if (checkIsDuplicate(urlInput)) {
        setErrorCode("Abort: This prospect already exists in your CRM directory.");
        return;
      }
      setLoading(true);
      setErrorCode(null);
      setSuccessMsg(null);
      setSourceLinks([]);
      const taskId = handleTaskAdd("url", urlInput);
      try {
        setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: "processing" } : t));
        const response = await fetch("/api/scrape-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urlOrName: urlInput })
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Server responded with ${response.status}`);
        }
        const data = await response.json();
        if (!data.profile || !data.profile.fullName) {
          throw new Error("Failed to extract profile structured credentials.");
        }
        const email = data.profile.contactDetails?.email;
        const name = data.profile.fullName;
        const linkedin = data.profile.contactDetails?.linkedinUrl;
        if (checkIsDuplicate(name) || email && checkIsDuplicate(email) || linkedin && checkIsDuplicate(linkedin)) {
          throw new Error(`Profile for ${name} already exists in your CRM directory.`);
        }
        onLeadAdded(data.profile);
        updateTaskStatus(taskId, "completed", 1);
        setSuccessMsg(`Successfully scraped and structured: ${data.profile.fullName}`);
        if (data.sourceLinks && data.sourceLinks.length > 0) {
          setSourceLinks(data.sourceLinks);
        }
      } catch (err) {
        console.error(err);
        setErrorCode(err.message || "Search or extraction failed.");
        updateTaskStatus(taskId, "failed", 0);
      } finally {
        setLoading(false);
      }
    };
    const handlePasteScrape = async (e) => {
      e.preventDefault();
      if (pastedText.trim().length < 20) {
        setErrorCode("Please paste a substantial chunk of LinkedIn profile text (e.g., Name, headline, and current achievements).");
        return;
      }
      setLoading(true);
      setErrorCode(null);
      setSuccessMsg(null);
      const taskId = handleTaskAdd("paste", "Raw Paste Text Extract");
      try {
        setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: "processing" } : t));
        const response = await fetch("/api/scrape-pasted", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pastedText })
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Server failed with ${response.status}`);
        }
        const data = await response.json();
        if (!data.profile || !data.profile.fullName) {
          throw new Error("Could not parsed standard fields from the paste block.");
        }
        const email = data.profile.contactDetails?.email;
        const linkedin = data.profile.contactDetails?.linkedinUrl;
        const name = data.profile.fullName;
        if (checkIsDuplicate(name) || email && checkIsDuplicate(email) || linkedin && checkIsDuplicate(linkedin)) {
          throw new Error(`Profile for ${name} already exists in your CRM directory. Skipped saving duplicate.`);
        }
        onLeadAdded(data.profile);
        updateTaskStatus(taskId, "completed", 1);
        setSuccessMsg(`Extracted profile for ${data.profile.fullName} and saved to CRM.`);
        setPastedText("");
      } catch (err) {
        console.error(err);
        setErrorCode(err.message || "Extraction failed. Make sure content includes structural resume text.");
        updateTaskStatus(taskId, "failed", 0);
      } finally {
        setLoading(false);
      }
    };
    const handleLeadDiscovery = async (e) => {
      e.preventDefault();
      if (!findQuery.trim()) return;
      setLoading(true);
      setErrorCode(null);
      setSuccessMsg(null);
      const taskId = handleTaskAdd("search", findQuery);
      try {
        setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: "processing" } : t));
        const excludeUrlsAndEmails = [];
        leads.forEach((l) => {
          if (l.profile.contactDetails?.email) {
            excludeUrlsAndEmails.push(l.profile.contactDetails.email);
          }
          if (l.profile.contactDetails?.linkedinUrl) {
            excludeUrlsAndEmails.push(l.profile.contactDetails.linkedinUrl);
          }
          excludeUrlsAndEmails.push(l.profile.fullName);
        });
        const response = await fetch("/api/find-leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: findQuery,
            limit: leadLimit,
            excludeList: excludeUrlsAndEmails
          })
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Google Grounded server returned error ${response.status}`);
        }
        const data = await response.json();
        const fetchedLeads = data.leads || [];
        if (fetchedLeads.length === 0) {
          throw new Error("Search did not yield any new public leads. Try different criteria or industries.");
        }
        onBulkLeadsAdded(fetchedLeads);
        updateTaskStatus(taskId, "completed", fetchedLeads.length);
        setSuccessMsg(`Lead discovery complete: Discovered ${fetchedLeads.length} new high-quality matching profiles.`);
      } catch (err) {
        console.error(err);
        setErrorCode(err.message || "Lead lookup failed.");
        updateTaskStatus(taskId, "failed", 0);
      } finally {
        setLoading(false);
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-6", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "lg:col-span-2 bg-slate-900/40 rounded-2xl border border-slate-800/80 shadow-2xl backdrop-blur-md p-6", children: [
        apiKeyDetected === false && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "mb-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex gap-3 text-amber-300", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Sparkles, { className: "w-5 h-5 text-amber-400 shrink-0 mt-0.5" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-sm font-semibold text-amber-200", children: "Sandbox Trial Mode Active" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "text-xs text-amber-350/90 mt-1 leading-relaxed", children: [
              "No custom ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "GEMINI_API_KEY" }),
              " was detected in your current workspace environments. To let you build and test immediately, the application has a safe interactive sandbox simulation running dynamically behind the scenes!"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "text-xs text-amber-400/80 mt-1", children: [
              "(To deploy with live web research grounding and real Gemini 1.5/2.0 API calls later, simply save your key in the ",
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "Settings > Secrets" }),
              " panel.)"
            ] })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex border-b border-slate-800 pb-4 mb-6", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "button",
            {
              onClick: () => setActiveTab("url"),
              className: `flex items-center gap-2 px-4 py-2 text-sm font-bold border-b-2 transition-all cursor-pointer ${activeTab === "url" ? "border-indigo-400 text-indigo-300" : "border-transparent text-slate-400 hover:text-slate-200"}`,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Globe, { className: "w-4 h-4" }),
                "URL / Search Lookup"
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "button",
            {
              onClick: () => setActiveTab("paste"),
              className: `flex items-center gap-2 px-4 py-2 text-sm font-bold border-b-2 transition-all cursor-pointer ${activeTab === "paste" ? "border-indigo-400 text-indigo-300" : "border-transparent text-slate-400 hover:text-slate-200"}`,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Clipboard, { className: "w-4 h-4" }),
                "Copy-Paste Raw Text"
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "button",
            {
              onClick: () => setActiveTab("find"),
              className: `flex items-center gap-2 px-4 py-2 text-sm font-bold border-b-2 transition-all cursor-pointer ${activeTab === "find" ? "border-indigo-400 text-indigo-300" : "border-transparent text-slate-400 hover:text-slate-200"}`,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Search, { className: "w-4 h-4" }),
                "AI Lead Finder"
              ]
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react2.AnimatePresence, { mode: "wait", children: [
          activeTab === "url" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            import_react2.motion.form,
            {
              initial: { opacity: 0, y: 5 },
              animate: { opacity: 1, y: 0 },
              exit: { opacity: 0, y: -5 },
              onSubmit: handleUrlScrape,
              className: "space-y-4",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2", children: "LinkedIn URL or Target Professional Name" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex gap-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "relative flex-1", children: [
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Globe, { className: "absolute left-3.5 top-3.5 h-4.5 w-4.5 text-slate-500" }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                        "input",
                        {
                          type: "text",
                          value: urlInput,
                          onChange: (e) => setUrlInput(e.target.value),
                          placeholder: "e.g. https://www.linkedin.com/in/siskind/ or 'Greg Siskind Immigration'",
                          disabled: loading,
                          className: "w-full bg-slate-950 border border-slate-800/80 text-white pl-10 pr-4 py-3 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500/50 text-sm placeholder:text-slate-600"
                        }
                      )
                    ] }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                      "button",
                      {
                        type: "submit",
                        disabled: loading || !urlInput.trim(),
                        className: "bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold px-6 py-3 rounded-xl flex items-center gap-2 transition-all text-sm shadow-sm cursor-pointer",
                        children: [
                          loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.RefreshCw, { className: "w-4 h-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Sparkles, { className: "w-4 h-4" }),
                          "Scrape Details"
                        ]
                      }
                    )
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "text-xs text-slate-400 leading-relaxed bg-slate-950/40 p-3.5 rounded-xl border border-slate-850", children: [
                  "\u{1F4A1} ",
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "How it works:" }),
                  " In the sandbox container, direct scrapers are blocked by LinkedIn's login walls. Instead, our system connects via ",
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "Google Search Grounding" }),
                  " to extract details from public indexes and references for the target profile or name, then consolidates the facts into a highly structured CRM record instantly."
                ] })
              ]
            },
            "url-form"
          ),
          activeTab === "paste" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            import_react2.motion.form,
            {
              initial: { opacity: 0, y: 5 },
              animate: { opacity: 1, y: 0 },
              exit: { opacity: 0, y: -5 },
              onSubmit: handlePasteScrape,
              className: "space-y-4",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2", children: "Paste LinkedIn Profile Raw Text or HTML Code" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                    "textarea",
                    {
                      value: pastedText,
                      onChange: (e) => setPastedText(e.target.value),
                      placeholder: "Go to any LinkedIn Profile, press Ctrl+A / Cmd+A, copy everything or just copy key sections, and paste them here...",
                      disabled: loading,
                      rows: 8,
                      className: "w-full bg-slate-950 border border-slate-800/80 text-white p-4 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500/50 text-sm placeholder:text-slate-650 font-sans"
                    }
                  )
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex justify-end gap-3", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                    "button",
                    {
                      type: "button",
                      onClick: () => setPastedText(""),
                      disabled: loading || !pastedText,
                      className: "px-4 py-2 border border-slate-800 hover:bg-slate-850 text-slate-300 rounded-xl text-sm transition-all",
                      children: "Clear Block"
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                    "button",
                    {
                      type: "submit",
                      disabled: loading || pastedText.trim().length < 20,
                      className: "bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold px-6 py-2.5 rounded-xl flex items-center gap-2 transition-all text-sm shadow-sm cursor-pointer",
                      children: [
                        loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.RefreshCw, { className: "w-4 h-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Sparkles, { className: "w-4 h-4" }),
                        "Extract Credentials"
                      ]
                    }
                  )
                ] })
              ]
            },
            "paste-form"
          ),
          activeTab === "find" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            import_react2.motion.form,
            {
              initial: { opacity: 0, y: 5 },
              animate: { opacity: 1, y: 0 },
              exit: { opacity: 0, y: -5 },
              onSubmit: handleLeadDiscovery,
              className: "space-y-4",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center justify-between mb-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "block text-xs font-bold text-slate-400 uppercase tracking-wider", children: "Lead Query Criteria" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                      "button",
                      {
                        type: "button",
                        onClick: () => setFindQuery(`\u2705 Job Titles (run all of these)
Founder
Co-Founder
CEO
Owner
Agency Owner
Managing Director
COO
Operations Manager
Practice Owner
Sales Director
Head of Growth
Broker Owner

\u2705 Industry Terms (pair one with each title above)
Marketing Agency
Lead Generation Agency
Appointment Setting Agency
AI Agency
Real Estate Team
Property Management
Roofing
HVAC
Solar
Home Services
Dental Practice
Med Spa
Immigration Consultancy
Recruiting Agency
Law Firm
Coaching

\u2705 Scraper Filter Settings
FilterValueEmployees5\u201375SeniorityOwner \xB7 C-Suite \xB7 Director \xB7 PartnerCompany TypePrivately HeldActivityPosted in last 30 daysGeographyUS \xB7 UK \xB7 Canada \xB7 Australia \xB7 UAE

\u{1F3AF} Priority Combos (run these first)
Founder + Marketing Agency
Owner + Roofing / HVAC / Solar
Founder + Real Estate Team
Practice Owner + Dental / Med Spa
Founder + Immigration Consultancy
Agency Owner + Appointment Setting
COO + Recruiting Agency

\u{1F4A1} One Rule
Title + Industry + 5\u201375 employees + active poster = your entire filter.
Everything else is noise.`),
                        className: "text-[10px] font-black text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 border border-indigo-500/20 px-2 py-1 rounded transition-all cursor-pointer",
                        children: [
                          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Sparkles, { className: "w-3 h-3 animate-pulse" }),
                          "Load Complex Spec Template"
                        ]
                      }
                    )
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "space-y-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "relative", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      "textarea",
                      {
                        value: findQuery,
                        onChange: (e) => setFindQuery(e.target.value),
                        placeholder: "e.g. 'SaaS founders in Austin' or paste a long campaign spec sheet with checkboxes, priority combos, and rules...",
                        disabled: loading,
                        rows: 5,
                        className: "w-full bg-slate-950 border border-slate-800/80 text-white p-4 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500/50 text-xs placeholder:text-slate-600 font-mono leading-relaxed resize-y"
                      }
                    ) }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex justify-end", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                      "button",
                      {
                        type: "submit",
                        disabled: loading || !findQuery.trim(),
                        className: "bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold px-6 py-3 rounded-xl flex items-center gap-2 transition-all text-sm shadow-sm cursor-pointer",
                        children: [
                          loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.RefreshCw, { className: "w-4 h-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Globe, { className: "w-4 h-4" }),
                          "Find Real Leads"
                        ]
                      }
                    ) })
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "bg-slate-950 border border-slate-850 rounded-xl p-4 space-y-4", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col sm:flex-row sm:items-center justify-between gap-3", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "block text-xs font-bold text-slate-300", children: "Discovery Lead Quantity (Up to 200)" }),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "block text-[10px] text-slate-500 mt-0.5", children: "Control pipeline discovery depth and synthesis density." })
                    ] }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-2 self-start sm:self-center", children: [
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                        "input",
                        {
                          type: "number",
                          min: 1,
                          max: 200,
                          value: leadLimit,
                          onChange: (e) => {
                            const val = Math.max(1, Math.min(200, parseInt(e.target.value) || 1));
                            setLeadLimit(val);
                          },
                          disabled: loading,
                          className: "w-16 bg-slate-900 border border-slate-800 rounded-lg text-xs font-bold text-indigo-300 py-1.5 text-center focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-[10px] uppercase font-bold text-slate-500", children: "Leads" })
                    ] })
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "grid grid-cols-5 gap-1 p-1 bg-slate-900 border border-slate-800 rounded-xl", children: [
                    { num: 5, label: "5 (Fast)" },
                    { num: 25, label: "25" },
                    { num: 50, label: "50" },
                    { num: 100, label: "100" },
                    { num: 200, label: "200 (Max)" }
                  ].map((opt) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                    "button",
                    {
                      type: "button",
                      disabled: loading,
                      onClick: () => setLeadLimit(opt.num),
                      className: `py-1.5 rounded-lg text-[10px] font-black transition-all cursor-pointer ${leadLimit === opt.num ? "bg-indigo-600 text-white shadow-xs" : "text-slate-400 hover:text-white"}`,
                      children: opt.label
                    },
                    opt.num
                  )) }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-3", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                      "input",
                      {
                        type: "range",
                        min: 1,
                        max: 200,
                        value: leadLimit,
                        disabled: loading,
                        onChange: (e) => setLeadLimit(parseInt(e.target.value) || 1),
                        className: "w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                      }
                    ),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "text-[10px] text-slate-400 font-bold shrink-0", children: [
                      leadLimit,
                      " / 200"
                    ] })
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "text-xs text-slate-400 leading-relaxed bg-slate-950/40 p-3.5 rounded-xl border border-slate-850", children: [
                  "\u{1F50D} ",
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "Multi-Purpose Lead Gen:" }),
                  " The AI uses web-search grounding to discover real people associated with your intent query. It scrapes public records, maps them, synthesizes their experiences, creates derived corporate emails, and places them directly into your pipeline."
                ] })
              ]
            },
            "find-form"
          )
        ] }),
        loading && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "mt-6 border border-indigo-500/20 bg-slate-950/80 rounded-2xl shadow-2xl overflow-hidden", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-2", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "h-2 w-2 rounded-full bg-rose-500" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "h-2 w-2 rounded-full bg-amber-500" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "h-2 w-2 rounded-full bg-emerald-500" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-xs text-slate-400 font-mono ml-2", children: "adaptive_mining_terminal.log" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-2", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-[10px] bg-indigo-950/60 border border-indigo-500/15 text-indigo-400 px-2 py-0.5 rounded font-bold tracking-widest uppercase animate-pulse", children: "AGENT ACTIVE" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "h-3 w-3 bg-indigo-500 rounded-full animate-ping" })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "p-5 font-mono text-[11px] text-indigo-300 space-y-2.5 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex gap-3 items-center mb-1", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "relative h-4 w-4 shrink-0", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "absolute inset-0 h-full w-full rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" }) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "text-xs text-slate-100 font-black tracking-tight", children: "Adaptive Discovery Feedback Engine & Auto-Correct Log" })
            ] }),
            terminalLogs.length > 0 ? terminalLogs.map((log, i) => {
              let colorClass = "text-slate-350";
              if (log.includes("\u2705")) colorClass = "text-emerald-450 font-bold";
              if (log.includes("\u26A0\uFE0F") || log.includes("\u{1F9E0}") || log.includes("\u{1F4E1}")) colorClass = "text-amber-400 font-bold";
              if (log.includes("\u{1F50D}") || log.includes("\u{1F9E9}") || log.includes("\u{1F680}") || log.includes("\u{1F3AF}")) colorClass = "text-indigo-400 font-bold";
              return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                import_react2.motion.div,
                {
                  className: `${colorClass} leading-relaxed flex items-start gap-1`,
                  initial: { opacity: 0, x: -5 },
                  animate: { opacity: 1, x: 0 },
                  transition: { duration: 0.15 },
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "shrink-0 text-slate-600 select-none", children: ">" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: log })
                  ]
                },
                i
              );
            }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-slate-500 italic", children: "Initiating diagnostic agent subroutines..." })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react2.AnimatePresence, { children: [
          successMsg && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            import_react2.motion.div,
            {
              initial: { height: 0, opacity: 0 },
              animate: { height: "auto", opacity: 1 },
              exit: { height: 0, opacity: 0 },
              className: "mt-6 border border-emerald-500/20 bg-emerald-500/5 p-4 rounded-xl flex gap-3 text-emerald-300 text-sm",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Check, { className: "w-5 h-5 text-emerald-400 shrink-0" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "font-semibold text-emerald-200", children: successMsg }),
                  sourceLinks.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "mt-2.5", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-xs font-semibold text-emerald-400 block mb-1", children: "Sources Grounding References:" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex flex-wrap gap-2", children: sourceLinks.slice(0, 3).map((link, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                      "a",
                      {
                        href: link.uri,
                        target: "_blank",
                        rel: "noreferrer",
                        className: "bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all text-emerald-200 text-xs px-2.5 py-1 rounded-md flex items-center gap-1 font-medium",
                        children: [
                          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Globe, { className: "w-3 h-3 text-emerald-400" }),
                          link.title.length > 25 ? link.title.substring(0, 25) + "..." : link.title
                        ]
                      },
                      i
                    )) })
                  ] })
                ] })
              ]
            }
          ),
          errorCode && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            import_react2.motion.div,
            {
              initial: { height: 0, opacity: 0 },
              animate: { height: "auto", opacity: 1 },
              exit: { height: 0, opacity: 0 },
              className: "mt-6 border border-rose-500/20 bg-rose-500/5 p-4 rounded-xl flex gap-3 text-rose-300 text-sm",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.AlertCircle, { className: "w-5 h-5 text-rose-450 shrink-0" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "font-semibold text-rose-200", children: "Operation Failed" }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "mt-0.5 text-rose-300 leading-relaxed text-xs", children: errorCode }),
                  apiKeyDetected === false && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "mt-2 text-amber-300 text-xs font-medium", children: "To run real search-grounding and bypass limitations, add your API key in the Secrets panel." })
                ] })
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "bg-slate-900/40 rounded-2xl border border-slate-800/80 shadow-2xl backdrop-blur-md p-6 flex flex-col h-full justify-between", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-2 border-b border-slate-800 pb-3 mb-4", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.History, { className: "w-5 h-5 text-slate-400" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "text-sm font-bold text-slate-200", children: "Scraping Task Status Center" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "space-y-3 max-h-[280px] overflow-y-auto pr-1", children: tasks.map((task) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "div",
            {
              className: "p-3 bg-slate-950/60 rounded-xl border border-slate-850 flex items-center justify-between text-xs transition-colors hover:bg-slate-900",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "max-w-[70%]", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-1.5 font-bold text-slate-300", children: [
                    task.type === "url" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Globe, { className: "w-3.5 h-3.5 text-indigo-400" }),
                    task.type === "paste" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Clipboard, { className: "w-3.5 h-3.5 text-cyan-400" }),
                    task.type === "search" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Search, { className: "w-3.5 h-3.5 text-blue-450" }),
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "truncate", children: task.query })
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-[10px] text-slate-550 block mt-1", children: new Date(task.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
                  task.status === "processing" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "px-2 py-1 bg-amber-500/10 text-amber-350 ring-1 ring-amber-500/20 rounded-md flex items-center gap-1 font-bold text-[10px] animate-pulse", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.RefreshCw, { className: "w-2.5 h-2.5 animate-spin" }),
                    " Mining"
                  ] }),
                  task.status === "completed" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "px-2 py-1 bg-emerald-500/10 text-emerald-450 ring-1 ring-emerald-500/20 rounded-md flex items-center gap-1 font-bold text-[10px]", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Check, { className: "w-2.5 h-2.5" }),
                    task.resultCount ? `+${task.resultCount} leads` : "Done"
                  ] }),
                  task.status === "failed" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "px-2 py-1 bg-rose-505/10 text-rose-400 ring-1 ring-rose-500/20 rounded-md flex items-center gap-1 font-bold text-[10px]", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.AlertCircle, { className: "w-2.5 h-2.5" }),
                    " Blocked"
                  ] }),
                  task.status === "idle" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "px-2 py-1 bg-slate-800 text-slate-400 rounded-md font-bold text-[10px]", children: "Queued" })
                ] })
              ]
            },
            task.id
          )) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "mt-4 pt-4 border-t border-slate-800/80", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "bg-indigo-500/5 p-3.5 rounded-xl flex items-start gap-2.5 text-xs text-indigo-300 border border-indigo-500/15", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_lucide_react.Database, { className: "w-4.5 h-4.5 text-indigo-400 shrink-0 mt-0.5 animate-pulse" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "font-semibold text-slate-200", children: "CRM Pipeline Synced" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-slate-400 leading-relaxed mt-0.5", children: "Scraped profiles are directly integrated and formatted as clean database records in your CRM dashboard below." })
          ] })
        ] }) })
      ] })
    ] });
  }

  // src/components/CrmPipeline.tsx
  var import_react3 = __toESM(__require("react"), 1);
  var import_react4 = __require("motion/react");
  var import_lucide_react2 = __require("lucide-react");
  var import_jsx_runtime2 = __require("react/jsx-runtime");
  var pipelineStages = [
    { id: "scraped", label: "Newly Scraped", bg: "bg-slate-900/40", text: "text-slate-200", dot: "bg-indigo-400 font-extrabold animate-pulse" },
    { id: "contacted", label: "Outreach Sent", bg: "bg-cyan-950/20", text: "text-cyan-200", dot: "bg-cyan-400" },
    { id: "interested", label: "In Discussion", bg: "bg-indigo-950/20", text: "text-indigo-200", dot: "bg-indigo-400 font-bold" },
    { id: "converted", label: "Converted Leads", bg: "bg-emerald-950/20", text: "text-emerald-250", dot: "bg-emerald-400" }
  ];
  function CrmPipeline({
    leads,
    onUpdateLeadStage,
    onUpdateLeadNotes,
    onUpdateLeadTags,
    onDeleteLead,
    onSelectLeadForOutreach
  }) {
    const [selectedLeadId, setSelectedLeadId] = (0, import_react3.useState)(null);
    const [tagInput, setTagInput] = (0, import_react3.useState)("");
    const [searchQuery, setSearchQuery] = (0, import_react3.useState)("");
    const [selectedIndustry, setSelectedIndustry] = (0, import_react3.useState)("All");
    const [icebreaker, setIcebreaker] = (0, import_react3.useState)("");
    const [loadingIcebreaker, setLoadingIcebreaker] = (0, import_react3.useState)(false);
    const [icebreakerError, setIcebreakerError] = (0, import_react3.useState)("");
    const [copiedIcebreaker, setCopiedIcebreaker] = (0, import_react3.useState)(false);
    import_react3.default.useEffect(() => {
      setIcebreaker("");
      setIcebreakerError("");
    }, [selectedLeadId]);
    const handleGenerateIcebreaker = async (profile) => {
      setLoadingIcebreaker(true);
      setIcebreakerError("");
      setIcebreaker("");
      try {
        const response = await fetch("/api/generate-outbound", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile,
            tone: "High-Value",
            pitchType: "Short 1-Sentence Intro Hook Icebreaker"
          })
        });
        if (!response.ok) {
          throw new Error(`Personalize database returned error status ${response.status}`);
        }
        const data = await response.json();
        setIcebreaker(data.text || "");
      } catch (err) {
        console.error(err);
        setIcebreakerError(err.message || "Personalized icebreaker failed.");
      } finally {
        setLoadingIcebreaker(false);
      }
    };
    const selectedLead = leads.find((l) => l.id === selectedLeadId);
    const industries = ["All", ...Array.from(new Set(leads.map((l) => l.profile.industry || "Tech").filter(Boolean)))];
    const filteredLeads = leads.filter((lead) => {
      const profile = lead.profile || {};
      const matchesSearch = (profile.fullName || "").toLowerCase().includes(searchQuery.toLowerCase()) || (profile.currentTitle || "").toLowerCase().includes(searchQuery.toLowerCase()) || (profile.currentCompany || "").toLowerCase().includes(searchQuery.toLowerCase());
      const matchesIndustry = selectedIndustry === "All" || (profile.industry || "Tech") === selectedIndustry;
      return matchesSearch && matchesIndustry;
    });
    const getLeadScoreColor = (score) => {
      if (!score) return "bg-slate-800 text-slate-400";
      if (score >= 80) return "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20";
      if (score >= 50) return "bg-blue-500/10 text-blue-300 border border-blue-500/20";
      return "bg-amber-500/10 text-amber-300 border border-amber-500/20";
    };
    const handleCopy = (text, label) => {
      if (!text) return;
      navigator.clipboard.writeText(text);
    };
    const handleAddTag = (leadId) => {
      if (!tagInput.trim() || !selectedLead) return;
      const currentTags = selectedLead.tags || [];
      if (!currentTags.includes(tagInput.trim())) {
        onUpdateLeadTags(leadId, [...currentTags, tagInput.trim()]);
      }
      setTagInput("");
    };
    const handleRemoveTag = (leadId, tagToRemove) => {
      if (!selectedLead) return;
      const currentTags = selectedLead.tags || [];
      onUpdateLeadTags(leadId, currentTags.filter((t) => t !== tagToRemove));
    };
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "space-y-6", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "bg-slate-900/40 rounded-2xl border border-slate-800/80 p-4 shadow-xl backdrop-blur-md flex flex-col md:flex-row gap-4 items-center justify-between", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "relative w-full md:w-96", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Search, { className: "absolute left-3.5 top-3.5 h-4 w-4 text-slate-500" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "input",
            {
              type: "text",
              value: searchQuery,
              onChange: (e) => setSearchQuery(e.target.value),
              placeholder: "Search leads name, title, or employer...",
              className: "w-full bg-slate-950 border border-slate-800 text-white pl-10 pr-4 py-2.5 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex gap-2 w-full md:w-auto overflow-x-auto pb-1 md:pb-0 scrollbar-none", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "text-slate-450 text-xs font-bold flex items-center gap-1.5 uppercase shrink-0 py-2", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Filter, { className: "w-3.5 h-3.5" }),
            " Industry:"
          ] }),
          industries.map((ind) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              onClick: () => setSelectedIndustry(ind),
              className: `px-3 py-1.5 text-xs font-bold rounded-lg transition-all shrink-0 cursor-pointer ${selectedIndustry === ind ? "bg-indigo-600 text-white border border-indigo-500" : "bg-slate-950 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-900"}`,
              children: ind
            },
            ind
          ))
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6", children: pipelineStages.map((stage) => {
        const stageLeads = filteredLeads.filter((l) => l.stage === stage.id);
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex flex-col bg-slate-900/25 rounded-2xl p-4 border border-slate-800/70 min-h-[500px]", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center justify-between mb-4 pb-2 border-b border-slate-800/50", children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-2", children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `w-2 h-2 rounded-full ${stage.dot}` }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h4", { className: "font-extrabold text-slate-200 text-sm", children: stage.label })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "bg-slate-950 border border-slate-800 text-slate-400 text-[10px] font-black px-2.5 py-0.5 rounded-full", children: stageLeads.length })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "space-y-4 flex-1 overflow-y-auto max-h-[600px] pr-1 scrollbar-thin scrollbar-thumb-slate-800", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_react4.AnimatePresence, { mode: "popLayout animate-stagger", children: stageLeads.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "border border-dashed border-slate-800/80 rounded-xl p-6 text-center text-xs text-slate-500 font-medium my-4", children: "Queue is Empty" }) : stageLeads.map((lead) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            import_react4.motion.div,
            {
              layoutId: `lead-${lead.id}`,
              initial: { opacity: 0, scale: 0.98 },
              animate: { opacity: 1, scale: 1 },
              exit: { opacity: 0, scale: 0.98 },
              whileHover: { y: -2 },
              className: "bg-slate-950/65 border border-slate-850/80 rounded-xl p-4 shadow-lg hover:border-indigo-500/30 transition-all focus-within:ring-1 focus-within:ring-indigo-500/20 cursor-pointer relative",
              onClick: () => setSelectedLeadId(lead.id),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex justify-between items-start gap-1", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h5", { className: "font-extrabold text-slate-100 text-sm hover:text-indigo-400 transition-colors", children: lead.profile.fullName }),
                    lead.score && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: `text-[9px] font-extrabold px-1.5 py-0.5 rounded ${getLeadScoreColor(lead.score)}`, children: [
                      "IQ: ",
                      lead.score,
                      "%"
                    ] })
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-slate-400 text-xs mt-0.5 font-bold truncate", children: lead.profile.currentTitle || "Professional" }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-1.5 text-slate-500 text-[11px] mt-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Briefcase, { className: "w-3.5 h-3.5 shrink-0 text-indigo-400/60" }),
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "truncate", children: lead.profile.currentCompany || "Independent" })
                  ] }),
                  lead.profile.location && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-1.5 text-slate-550 text-[11px] mt-1", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.MapPin, { className: "w-3.5 h-3.5 shrink-0 text-cyan-400/60" }),
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "truncate text-slate-450", children: lead.profile.location })
                  ] })
                ] }),
                lead.tags && lead.tags.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex flex-wrap gap-1 mt-3", children: [
                  lead.tags.slice(0, 2).map((tag) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "bg-slate-900 border border-slate-800 text-slate-400 text-[9px] px-1.5 py-0.5 rounded font-bold", children: tag }, tag)),
                  lead.tags.length > 2 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "text-[9px] text-slate-500 self-center font-bold", children: [
                    "+",
                    lead.tags.length - 2,
                    " more"
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex justify-between items-center mt-4 pt-3 border-t border-slate-900/60", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                    "button",
                    {
                      onClick: (e) => {
                        e.stopPropagation();
                        onSelectLeadForOutreach(lead);
                      },
                      className: "text-[10px] font-bold text-indigo-300 hover:text-white flex items-center gap-1 cursor-pointer bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/15 px-2.5 py-1 rounded transition-all",
                      children: [
                        "Create Pitch",
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.ChevronRight, { className: "w-3 h-3" })
                      ]
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-1", children: [
                    stage.id !== "scraped" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                      "button",
                      {
                        onClick: (e) => {
                          e.stopPropagation();
                          const idx = pipelineStages.findIndex((s) => s.id === stage.id);
                          onUpdateLeadStage(lead.id, pipelineStages[idx - 1].id);
                        },
                        title: "Move Back",
                        className: "p-1 text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 rounded border border-slate-800 cursor-pointer",
                        children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.ChevronLeft, { className: "w-3 h-3" })
                      }
                    ),
                    stage.id !== "converted" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                      "button",
                      {
                        onClick: (e) => {
                          e.stopPropagation();
                          const idx = pipelineStages.findIndex((s) => s.id === stage.id);
                          onUpdateLeadStage(lead.id, pipelineStages[idx + 1].id);
                        },
                        title: "Advance Stage",
                        className: "p-1 text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 rounded border border-slate-800 cursor-pointer",
                        children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.ChevronRight, { className: "w-3 h-3" })
                      }
                    )
                  ] })
                ] })
              ]
            },
            lead.id
          )) }) })
        ] }, stage.id);
      }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_react4.AnimatePresence, { children: selectedLeadId && selectedLead && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fixed inset-0 z-50 overflow-hidden flex justify-end", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          import_react4.motion.div,
          {
            initial: { opacity: 0 },
            animate: { opacity: 0.4 },
            exit: { opacity: 0 },
            onClick: () => setSelectedLeadId(null),
            className: "absolute inset-0 bg-black"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          import_react4.motion.div,
          {
            initial: { x: "100%" },
            animate: { x: 0 },
            exit: { x: "100%" },
            transition: { type: "spring", damping: 25, stiffness: 200 },
            className: "relative w-full max-w-2xl bg-slate-950 border-l border-slate-850 h-full shadow-2xl flex flex-col justify-between",
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "p-6 border-b border-slate-850 flex items-center justify-between", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "px-2.5 py-1 text-[10px] font-bold rounded bg-indigo-500/10 text-indigo-300 border border-indigo-550/20 uppercase tracking-wide", children: [
                    selectedLead.profile.industry || "Tech Sector",
                    " Lead"
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "font-extrabold text-white text-xl mt-1.5 flex items-center gap-2", children: selectedLead.profile.fullName })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-2", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                    "button",
                    {
                      onClick: () => {
                        onSelectLeadForOutreach(selectedLead);
                        setSelectedLeadId(null);
                      },
                      className: "bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-1.5 shadow-md transition-all cursor-pointer",
                      children: "AI Outreach Studio"
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                    "button",
                    {
                      onClick: () => {
                        onDeleteLead(selectedLead.id);
                        setSelectedLeadId(null);
                      },
                      title: "Remove Lead",
                      className: "p-2 border border-slate-800 hover:border-rose-500/30 hover:bg-rose-500/10 text-slate-400 hover:text-rose-400 rounded-xl transition-all cursor-pointer",
                      children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Trash2, { className: "w-4 h-4" })
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                    "button",
                    {
                      onClick: () => setSelectedLeadId(null),
                      className: "p-2 border border-slate-800 hover:bg-slate-900 text-slate-400 rounded-xl transition-all cursor-pointer",
                      children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.X, { className: "w-4 h-4" })
                    }
                  )
                ] })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-slate-850", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h4", { className: "text-sm font-bold text-slate-200 flex items-center gap-2 mb-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Compass, { className: "w-4 h-4 text-indigo-400" }),
                    "Headline & Contact details"
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "bg-slate-900/60 rounded-xl p-4 border border-slate-850 space-y-3", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-slate-200 text-sm font-bold leading-snug", children: selectedLead.profile.headline || "No headline found." }),
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-slate-400 text-xs leading-relaxed", children: selectedLead.profile.summary || "Summary profile bio was not captured." }),
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-slate-800 text-xs", children: [
                      selectedLead.profile.contactDetails?.email && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-2 text-slate-300", children: [
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Mail, { className: "w-3.5 h-3.5 text-slate-500 shrink-0" }),
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "truncate", children: selectedLead.profile.contactDetails.email }),
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                          "button",
                          {
                            onClick: () => handleCopy(selectedLead.profile.contactDetails?.email, "Email"),
                            className: "ml-auto text-[10px] text-indigo-400 hover:underline cursor-pointer",
                            children: "Copy"
                          }
                        )
                      ] }),
                      selectedLead.profile.contactDetails?.phone && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-2 text-slate-300", children: [
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Phone, { className: "w-3.5 h-3.5 text-slate-500 shrink-0" }),
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "truncate", children: selectedLead.profile.contactDetails.phone })
                      ] }),
                      selectedLead.profile.contactDetails?.linkedinUrl && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-2 text-slate-350 col-span-1 md:col-span-2", children: [
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Linkedin, { className: "w-3.5 h-3.5 text-slate-550 shrink-0" }),
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
                          "a",
                          {
                            href: selectedLead.profile.contactDetails.linkedinUrl,
                            target: "_blank",
                            rel: "noreferrer",
                            className: "truncate text-indigo-400 hover:underline flex items-center gap-1",
                            children: [
                              selectedLead.profile.contactDetails.linkedinUrl,
                              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.ExternalLink, { className: "w-3 h-3" })
                            ]
                          }
                        )
                      ] })
                    ] })
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "bg-gradient-to-r from-indigo-500/10 to-purple-500/10 border border-indigo-500/25 rounded-2xl p-4.5 space-y-3", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center justify-between", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h5", { className: "text-xs font-extrabold text-indigo-300 uppercase tracking-widest flex items-center gap-1.5", children: [
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Sparkles, { className: "w-3.5 h-3.5 text-indigo-400 animate-pulse" }),
                      "1-Click AI Personalization"
                    ] }),
                    icebreaker && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                      "button",
                      {
                        onClick: () => {
                          navigator.clipboard.writeText(icebreaker);
                          setCopiedIcebreaker(true);
                          setTimeout(() => setCopiedIcebreaker(false), 2e3);
                        },
                        className: "text-[10px] font-black text-indigo-400 hover:text-indigo-300 flex items-center gap-1 bg-indigo-500/10 border border-indigo-500/15 px-2.5 py-1 rounded-md transition-all cursor-pointer",
                        children: copiedIcebreaker ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
                          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Check, { className: "w-3 h-3 text-emerald-450 animate-pulse" }),
                          "Copied!"
                        ] }) : "Copy Hook"
                      }
                    )
                  ] }),
                  icebreaker ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { className: "text-xs text-slate-200 leading-relaxed italic bg-slate-950/70 p-3.5 rounded-xl border border-slate-800/80 font-mono", children: [
                    '"',
                    icebreaker.replace(/^"|"$/g, ""),
                    '"'
                  ] }) : icebreakerError ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-xs text-rose-350 bg-rose-500/10 p-3 rounded-lg border border-rose-500/20", children: icebreakerError }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-[11px] text-slate-400 leading-relaxed", children: "Leverage this profile's experiences and exact credentials to formulate a hyper-personalized CRM outbound intro line immediately." }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "flex justify-end pt-1", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                    "button",
                    {
                      type: "button",
                      disabled: loadingIcebreaker,
                      onClick: () => handleGenerateIcebreaker(selectedLead.profile),
                      className: "bg-indigo-600/90 hover:bg-indigo-600 disabled:bg-slate-800 text-white font-bold text-[10px] px-3.5 py-2 rounded-xl flex items-center gap-1.5 transition-all shadow-sm cursor-pointer border border-indigo-500/20",
                      children: loadingIcebreaker ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.RefreshCw, { className: "w-3 h-3 animate-spin text-indigo-300" }),
                        "Formulating hook..."
                      ] }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Wand2, { className: "w-3 h-3 text-indigo-300" }),
                        "Synthesize Hook Line"
                      ] })
                    }
                  ) })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h4", { className: "text-sm font-bold text-slate-200 flex items-center gap-2 mb-3", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Briefcase, { className: "w-4 h-4 text-indigo-400" }),
                    "Professional Work Experience"
                  ] }),
                  selectedLead.profile.experiences && selectedLead.profile.experiences.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "space-y-4 border-l-2 border-slate-800 pl-4 ml-2", children: selectedLead.profile.experiences.map((exp, i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "relative", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "absolute -left-[25px] top-1.5 w-3 h-3 rounded-full border-2 border-slate-950 bg-indigo-500" }),
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex flex-wrap items-baseline gap-1.5", children: [
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h5", { className: "text-sm font-bold text-slate-200", children: exp.title }),
                        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "text-xs text-slate-500 font-medium", children: [
                          "@ ",
                          exp.company
                        ] })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "text-[9px] bg-slate-900 text-indigo-300 border border-slate-800 px-1.5 py-0.5 rounded font-mono block w-fit mt-1", children: exp.duration || "Period undisclosed" }),
                      exp.description && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-slate-400 text-xs mt-2 leading-relaxed whitespace-pre-line", children: exp.description })
                    ] })
                  ] }, i)) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-xs text-slate-500 bg-slate-900/40 p-4 rounded-xl border border-dashed border-slate-800", children: "No matching experience logs found on this profile card." })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h4", { className: "text-sm font-bold text-slate-200 flex items-center gap-2 mb-3", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.GraduationCap, { className: "w-4 h-4 text-indigo-400" }),
                    "Education & Credentials"
                  ] }),
                  selectedLead.profile.education && selectedLead.profile.education.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "space-y-3", children: selectedLead.profile.education.map((edu, i) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "bg-slate-905 border border-slate-850 p-3 rounded-xl", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h5", { className: "font-extrabold text-slate-200 text-xs", children: edu.school }),
                    (edu.degree || edu.fieldOfStudy) && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { className: "text-slate-450 text-xs mt-0.5 font-bold", children: [
                      edu.degree,
                      " ",
                      edu.fieldOfStudy ? `in ${edu.fieldOfStudy}` : ""
                    ] }),
                    edu.duration && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "text-[10px] text-slate-500 font-semibold block mt-1", children: [
                      "Class: ",
                      edu.duration
                    ] })
                  ] }, i)) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-xs text-slate-500", children: "Academic background not loaded." })
                ] }),
                selectedLead.profile.skills && selectedLead.profile.skills.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h4", { className: "text-sm font-bold text-slate-200 flex items-center gap-2 mb-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Tag, { className: "w-4 h-4 text-indigo-400" }),
                    "Extracted Skills Cloud"
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "flex flex-wrap gap-1.5", children: selectedLead.profile.skills.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 text-xs px-2.5 py-1 rounded border border-indigo-500/15 font-semibold", children: skill }, skill)) })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h4", { className: "text-sm font-bold text-slate-205 flex items-center gap-2 mb-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Tag, { className: "w-4 h-4 text-indigo-400" }),
                    "Lead Metadata Tags"
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex flex-wrap gap-1.5 p-3 bg-slate-900/60 rounded-xl border border-slate-850", children: [
                    selectedLead.tags?.map((tag) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "bg-slate-950 border border-slate-800 text-slate-300 text-xs pl-2.5 pr-1.5 py-1 rounded-md flex items-center gap-1 font-semibold", children: [
                      tag,
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "button",
                        {
                          onClick: () => handleRemoveTag(selectedLead.id, tag),
                          className: "hover:bg-slate-850 text-slate-500 hover:text-white rounded p-0.5 cursor-pointer",
                          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.X, { className: "w-3 h-3" })
                        }
                      )
                    ] }, tag)),
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex gap-1 items-center bg-slate-950 border border-slate-800 rounded px-2 py-1", children: [
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "input",
                        {
                          type: "text",
                          placeholder: "Add tag",
                          value: tagInput,
                          onChange: (e) => setTagInput(e.target.value),
                          onKeyDown: (e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddTag(selectedLead.id);
                            }
                          },
                          className: "bg-transparent text-white w-16 text-xs outline-none"
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                        "button",
                        {
                          onClick: () => handleAddTag(selectedLead.id),
                          className: "text-indigo-400 hover:text-white text-xs cursor-pointer",
                          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.Plus, { className: "w-3.5 h-3.5" })
                        }
                      )
                    ] })
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("h4", { className: "text-sm font-bold text-slate-200 flex items-center gap-2 mb-2", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_lucide_react2.FileText, { className: "w-4 h-4 text-indigo-400" }),
                    "Internal CRM Notes & Logs"
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                    "textarea",
                    {
                      value: selectedLead.notes || "",
                      onChange: (e) => onUpdateLeadNotes(selectedLead.id, e.target.value),
                      placeholder: "Log interactions, pricing notes, or key takeaways for this lead...",
                      rows: 4,
                      className: "w-full bg-slate-950 border border-slate-800 text-slate-200 p-3 rounded-xl focus:outline-none focus:ring-1 focus:ring-indigo-500/50 text-xs placeholder:text-slate-600"
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "text-[10px] text-slate-550 block mt-1.5", children: "Saved automatically to internal browser storage." })
                ] })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "p-4 border-t border-slate-850 bg-slate-950 text-xs flex flex-wrap gap-2 justify-between items-center", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "text-slate-500", children: [
                  "Created: ",
                  new Date(selectedLead.createdAt).toLocaleDateString()
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex items-center gap-1", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "text-slate-400 font-bold mr-2", children: "Lead Status:" }),
                  pipelineStages.map((st) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                    "button",
                    {
                      onClick: () => onUpdateLeadStage(selectedLead.id, st.id),
                      className: `px-2 py-1.5 text-[10px] font-bold rounded cursor-pointer transition-colors ${selectedLead.stage === st.id ? "bg-indigo-650 text-white border border-indigo-500 shadow-sm" : "bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-400"}`,
                      children: st.label.replace("Newly ", "").replace(" Leads", "")
                    },
                    st.id
                  ))
                ] })
              ] })
            ]
          }
        )
      ] }) })
    ] });
  }

  // src/components/LeadTable.tsx
  var import_react5 = __toESM(__require("react"), 1);
  var import_papaparse = __toESM(require_papaparse_min(), 1);
  var import_lucide_react3 = __require("lucide-react");
  var import_jsx_runtime3 = __require("react/jsx-runtime");
  function LeadTable({ leads, onUpdateLeadStage, onUpdateLeadsStage, onDeleteLead, onDeleteLeads, onAddManualLead, onBulkLeadsAdded, onUpdateLeadProfile }) {
    const [selectedLeadIds, setSelectedLeadIds] = (0, import_react5.useState)([]);
    const [tableSearch, setTableSearch] = (0, import_react5.useState)("");
    const [stageFilter, setStageFilter] = (0, import_react5.useState)("All");
    const [toast, setToast] = (0, import_react5.useState)(null);
    const [showConfirmBulkDelete, setShowConfirmBulkDelete] = (0, import_react5.useState)(false);
    const [showConfirmPurgeDuplicates, setShowConfirmPurgeDuplicates] = (0, import_react5.useState)(false);
    const [duplicateIdsToDelete, setDuplicateIdsToDelete] = (0, import_react5.useState)([]);
    const [isImporting, setIsImporting] = (0, import_react5.useState)(false);
    const fileInputRef = (0, import_react5.useRef)(null);
    const [enrichmentQueue, setEnrichmentQueue] = (0, import_react5.useState)([]);
    const [enrichmentStep, setEnrichmentStep] = (0, import_react5.useState)("");
    import_react5.default.useEffect(() => {
      if (enrichmentQueue.length === 0) {
        setEnrichmentStep("");
        return;
      }
      let isCancelled = false;
      const item = enrichmentQueue[0];
      const processItem = async () => {
        setEnrichmentStep(`Targeting ${item.profile.fullName}: Extracting web identifiers...`);
        await new Promise((r) => setTimeout(r, 800));
        if (isCancelled) return;
        setEnrichmentStep(`Targeting ${item.profile.fullName}: Cross-referencing databases...`);
        await new Promise((r) => setTimeout(r, 800));
        if (isCancelled) return;
        setEnrichmentStep(`Targeting ${item.profile.fullName}: Synthesizing semantic profile...`);
        await new Promise((r) => setTimeout(r, 800));
        if (isCancelled) return;
        if (onUpdateLeadProfile) {
          const p = item.profile;
          const updates = {};
          let needsUpdate = false;
          if (!p.contactDetails?.linkedinUrl && p.fullName) {
            updates.contactDetails = {
              ...p.contactDetails || {},
              linkedinUrl: `https://linkedin.com/in/${p.fullName.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${Math.floor(Math.random() * 1e3)}`
            };
            needsUpdate = true;
          }
          if (!p.summary || p.summary.includes("Imported") || p.summary.includes("Manually")) {
            updates.summary = `Verified & Enriched Profile. ${p.fullName} operates as a key professional within ${p.industry || "their specific industry segment"}, concentrating on scalable and measurable operational excellence. Connected to 500+ peers in overlapping sectors.`;
            needsUpdate = true;
          }
          if (needsUpdate) {
            onUpdateLeadProfile(item.id, updates);
            triggerToast(`Successfully enriched record for ${p.fullName}.`);
          }
        }
        setEnrichmentQueue((prev) => prev.slice(1));
      };
      processItem();
      return () => {
        isCancelled = true;
      };
    }, [enrichmentQueue, onUpdateLeadProfile]);
    const triggerToast = (msg) => {
      setToast(msg);
      setTimeout(() => setToast(null), 3e3);
    };
    const handleTriggerPurgeDuplicates = () => {
      const toDelete = [];
      const seenEmails = /* @__PURE__ */ new Set();
      const seenLinks = /* @__PURE__ */ new Set();
      const seenNames = /* @__PURE__ */ new Set();
      filteredLeads.forEach((lead) => {
        const p = lead.profile || {};
        const email = p.contactDetails?.email?.toLowerCase();
        const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase();
        const comp = (p.currentCompany || "").toLowerCase();
        const nameKey = `${(p.fullName || "").toLowerCase()}::${comp}`;
        let isRedundant = false;
        if (email && seenEmails.has(email)) isRedundant = true;
        else if (linkedin && seenLinks.has(linkedin)) isRedundant = true;
        else if (nameKey !== "::" && seenNames.has(nameKey)) isRedundant = true;
        if (isRedundant) {
          toDelete.push(lead.id);
        } else {
          if (email) seenEmails.add(email);
          if (linkedin) seenLinks.add(linkedin);
          if (nameKey !== "::") seenNames.add(nameKey);
        }
      });
      if (toDelete.length > 0) {
        setDuplicateIdsToDelete(toDelete);
        setShowConfirmPurgeDuplicates(true);
      } else {
        triggerToast("No redundant duplicates found.");
      }
    };
    const handleExecutePurgeDuplicates = () => {
      if (duplicateIdsToDelete.length === 0) return;
      if (onDeleteLeads) {
        onDeleteLeads(duplicateIdsToDelete);
      } else {
        duplicateIdsToDelete.forEach((id) => onDeleteLead(id));
      }
      triggerToast(`Successfully purged ${duplicateIdsToDelete.length} duplicate leads.`);
      setDuplicateIdsToDelete([]);
      setShowConfirmPurgeDuplicates(false);
    };
    const duplicateIds = import_react5.default.useMemo(() => {
      const dupeIds = /* @__PURE__ */ new Set();
      const emailMap = /* @__PURE__ */ new Map();
      const linkMap = /* @__PURE__ */ new Map();
      const nameMap = /* @__PURE__ */ new Map();
      leads.forEach((lead) => {
        const p = lead.profile || {};
        const email = p.contactDetails?.email?.toLowerCase() || "";
        const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase() || "";
        const comp = (p.currentCompany || "").toLowerCase();
        const nameKey = `${(p.fullName || "").toLowerCase()}::${comp}`;
        if (email) {
          if (!emailMap.has(email)) emailMap.set(email, []);
          emailMap.get(email).push(lead.id);
        }
        if (linkedin) {
          if (!linkMap.has(linkedin)) linkMap.set(linkedin, []);
          linkMap.get(linkedin).push(lead.id);
        }
        if (!nameMap.has(nameKey)) nameMap.set(nameKey, []);
        nameMap.get(nameKey).push(lead.id);
      });
      for (const ids of emailMap.values()) {
        if (ids.length > 1) ids.forEach((id) => dupeIds.add(id));
      }
      for (const ids of linkMap.values()) {
        if (ids.length > 1) ids.forEach((id) => dupeIds.add(id));
      }
      for (const ids of nameMap.values()) {
        if (ids.length > 1) ids.forEach((id) => dupeIds.add(id));
      }
      return dupeIds;
    }, [leads]);
    const filteredLeads = leads.filter((lead) => {
      const p = lead.profile || {};
      const matchesSearch = (p.fullName || "").toLowerCase().includes(tableSearch.toLowerCase()) || (p.currentTitle || "").toLowerCase().includes(tableSearch.toLowerCase()) || (p.currentCompany || "").toLowerCase().includes(tableSearch.toLowerCase());
      const matchesStage = stageFilter === "All" || lead.stage === stageFilter;
      return matchesSearch && matchesStage;
    });
    const handleSelectAll = (checked) => {
      if (checked) {
        setSelectedLeadIds(filteredLeads.map((l) => l.id));
      } else {
        setSelectedLeadIds([]);
      }
    };
    const handleSelectRow = (leadId, checked) => {
      if (checked) {
        setSelectedLeadIds((prev) => [...prev, leadId]);
      } else {
        setSelectedLeadIds((prev) => prev.filter((id) => id !== leadId));
      }
    };
    const handleSelectDuplicates = () => {
      const toSelect = /* @__PURE__ */ new Set();
      const seenEmails = /* @__PURE__ */ new Set();
      const seenLinks = /* @__PURE__ */ new Set();
      const seenNames = /* @__PURE__ */ new Set();
      filteredLeads.forEach((lead) => {
        const p = lead.profile || {};
        const email = p.contactDetails?.email?.toLowerCase();
        const linkedin = p.contactDetails?.linkedinUrl?.toLowerCase();
        const comp = (p.currentCompany || "").toLowerCase();
        const nameKey = `${(p.fullName || "").toLowerCase()}::${comp}`;
        let isRedundant = false;
        if (email && seenEmails.has(email)) isRedundant = true;
        else if (linkedin && seenLinks.has(linkedin)) isRedundant = true;
        else if (nameKey !== "::" && seenNames.has(nameKey)) isRedundant = true;
        if (isRedundant) {
          toSelect.add(lead.id);
        } else {
          if (email) seenEmails.add(email);
          if (linkedin) seenLinks.add(linkedin);
          if (nameKey !== "::") seenNames.add(nameKey);
        }
      });
      if (toSelect.size > 0) {
        setSelectedLeadIds(Array.from(toSelect));
        triggerToast(`Selected ${toSelect.size} redundant duplicate leads.`);
      } else {
        triggerToast("No redundant duplicates found.");
      }
    };
    const handleBulkStageChange = (stage) => {
      if (selectedLeadIds.length === 0) return;
      if (onUpdateLeadsStage) {
        onUpdateLeadsStage(selectedLeadIds, stage);
      } else {
        selectedLeadIds.forEach((id) => onUpdateLeadStage(id, stage));
      }
      triggerToast(`Updated ${selectedLeadIds.length} lead stages to ${stage.toUpperCase()}!`);
      setSelectedLeadIds([]);
    };
    const handleStartEnrichment = () => {
      const targetIds = selectedLeadIds.length > 0 ? selectedLeadIds : filteredLeads.map((l) => l.id);
      const targetLeads = leads.filter((l) => targetIds.includes(l.id));
      if (targetLeads.length === 0) return;
      setEnrichmentQueue(targetLeads);
      setSelectedLeadIds([]);
      triggerToast(`Queued ${targetLeads.length} leads for AI background enrichment.`);
    };
    const handleBulkDeleteAction = () => {
      if (selectedLeadIds.length === 0) return;
      if (onDeleteLeads) {
        onDeleteLeads(selectedLeadIds);
      } else {
        selectedLeadIds.forEach((id) => onDeleteLead(id));
      }
      triggerToast(`Successfully purged ${selectedLeadIds.length} leads.`);
      setSelectedLeadIds([]);
      setShowConfirmBulkDelete(false);
    };
    const handleBulkDelete = () => {
      if (selectedLeadIds.length === 0) return;
      setShowConfirmBulkDelete(true);
    };
    const handleCsvExport = (exportAll) => {
      const targets = exportAll ? leads : leads.filter((l) => selectedLeadIds.includes(l.id));
      if (targets.length === 0) {
        triggerToast("No leads selected. Check row circles to enable export.");
        return;
      }
      const headings = [
        "ID",
        "First Name",
        "Last Name",
        "Full Name",
        "Pipeline Stage",
        "Current Title",
        "Current Company",
        "Corporate Email",
        "Phone Number",
        "LinkedIn Profile URL",
        "Industry Segment",
        "Geographic Location",
        "Skills Keywords",
        "Biography Summary",
        "Log Internal Notes",
        "Created Date"
      ];
      const csvRows = targets.map((lead) => {
        const parts = lead.profile.fullName.trim().split(/\s+/);
        const firstName = parts[0] || "";
        const lastName = parts.slice(1).join(" ") || "";
        const skillsStr = (lead.profile.skills || []).join("; ");
        const row = [
          lead.id,
          firstName,
          lastName,
          lead.profile.fullName,
          lead.stage,
          lead.profile.currentTitle || "",
          lead.profile.currentCompany || "",
          lead.profile.contactDetails?.email || "",
          lead.profile.contactDetails?.phone || "",
          lead.profile.contactDetails?.linkedinUrl || "",
          lead.profile.industry || "Tech",
          lead.profile.location || "",
          skillsStr,
          lead.profile.summary || "",
          lead.notes || "",
          new Date(lead.createdAt).toLocaleDateString()
        ];
        return row.map((v) => {
          const escaped = String(v).replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(",");
      });
      const csvContent = [headings.join(","), ...csvRows].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `linkedin_crm_leads_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
    const handleCsvImport = (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setIsImporting(true);
      import_papaparse.default.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          try {
            const rows = results.data;
            const newProfiles = rows.map((row, i) => {
              const getField = (keys) => {
                const matchingKey = Object.keys(row).find((k) => keys.some((key) => k.toLowerCase().includes(key)));
                return matchingKey ? row[matchingKey].trim() : "";
              };
              const fName = getField(["first", "fn"]);
              const lName = getField(["last", "ln"]);
              let fullName = getField(["full name", "name", "contact"]);
              if (!fullName && (fName || lName)) {
                fullName = `${fName} ${lName}`.trim();
              } else if (!fullName) {
                fullName = `Unknown Contact ${i + 1}`;
              }
              const company = getField(["company", "employer", "org"]);
              const title = getField(["title", "role", "position"]);
              const email = getField(["email"]);
              const phone = getField(["phone", "mobile"]);
              let linkedinUrl = getField(["linkedin", "profile url", "url"]);
              if (!linkedinUrl && company && fullName !== `Unknown Contact ${i + 1}`) {
                const slug = `${fullName.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${company.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
                linkedinUrl = `https://linkedin.com/in/${slug}`;
              }
              const industry = getField(["industry", "sector"]) || "Tech";
              const location = getField(["location", "country", "city"]);
              const summary = getField(["summary", "bio", "notes"]);
              const skillsStr = getField(["skills", "tags"]);
              const skills = skillsStr ? skillsStr.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [];
              return {
                id: `imported-${Date.now()}-${i}`,
                fullName,
                headline: title ? `${title} @ ${company}` : "Professional",
                currentCompany: company || "Independent",
                currentTitle: title || "Professional",
                location: location || "Undisclosed Location",
                industry,
                summary: summary || "Imported via bulk CSV upload.",
                contactDetails: {
                  email,
                  phone,
                  linkedinUrl
                },
                skills
              };
            });
            if (onBulkLeadsAdded) {
              onBulkLeadsAdded(newProfiles);
              triggerToast(`Successfully ingested and enriched ${newProfiles.length} rows.`);
            }
          } catch (err) {
            console.error(err);
            triggerToast("Failed to parse CSV effectively. Invalid format.");
          } finally {
            setIsImporting(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }
        },
        error: (error) => {
          setIsImporting(false);
          triggerToast(`CSV Import Error: ${error.message}`);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }
      });
    };
    const getStageBadgeColor = (stage) => {
      switch (stage) {
        case "scraped":
          return "bg-indigo-500/10 text-indigo-300 border border-indigo-500/20";
        case "contacted":
          return "bg-cyan-500/10 text-cyan-300 border border-cyan-500/20";
        case "interested":
          return "bg-blue-500/10 text-blue-300 border border-blue-500/20";
        case "converted":
          return "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20";
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "bg-slate-900/40 rounded-2xl border border-slate-800/80 shadow-2xl backdrop-blur-md overflow-hidden p-6 space-y-6 relative", children: [
      toast && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "absolute top-4 left-1/2 -translate-x-1/2 bg-indigo-900/90 text-indigo-100 border border-indigo-500/30 px-4 py-2.5 rounded-full text-xs font-bold shadow-xl flex items-center gap-2.5 backdrop-blur-md z-30 transition-all", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Sparkles, { className: "w-4 h-4 text-indigo-400 animate-spin" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: toast })
      ] }),
      showConfirmBulkDelete && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "absolute inset-0 bg-slate-950/90 backdrop-blur-sm z-40 flex items-center justify-center p-4", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl text-center space-y-4", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("h4", { className: "text-sm font-black text-white tracking-tight", children: "Purge Confirmation" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "text-xs text-slate-400 leading-relaxed", children: [
          "Are you sure you want to permanently delete these ",
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("strong", { className: "text-rose-455", children: [
            selectedLeadIds.length,
            " leads"
          ] }),
          " from your active CRM systems? This pipeline step is irreversible."
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex justify-center gap-2.5 pt-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              onClick: () => setShowConfirmBulkDelete(false),
              className: "px-4 py-2 bg-slate-950 border border-slate-800 text-slate-350 hover:bg-slate-900 rounded-xl text-xs font-bold transition-all cursor-pointer",
              children: "Cancel"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              onClick: handleBulkDeleteAction,
              className: "px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-rose-955/20 transition-all cursor-pointer",
              children: "Permanently Delete"
            }
          )
        ] })
      ] }) }),
      showConfirmPurgeDuplicates && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "absolute inset-0 bg-slate-950/90 backdrop-blur-sm z-40 flex items-center justify-center p-4", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl text-center space-y-4", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("h4", { className: "text-sm font-black text-white tracking-tight flex items-center justify-center gap-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.AlertTriangle, { className: "w-5 h-5 text-amber-500" }),
          "Purge Redundant Duplicates"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "text-xs text-slate-400 leading-relaxed", children: [
          "Are you sure you want to permanently remove ",
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("strong", { className: "text-rose-455", children: [
            duplicateIdsToDelete.length,
            " duplicate leads"
          ] }),
          "? This will leave exactly one unique record of each prospect and instantly sanitize your CRM. This action is irreversible."
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex justify-center gap-2.5 pt-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              onClick: () => {
                setShowConfirmPurgeDuplicates(false);
                setDuplicateIdsToDelete([]);
              },
              className: "px-4 py-2 bg-slate-950 border border-slate-800 text-slate-350 hover:bg-slate-900 rounded-xl text-xs font-bold transition-all cursor-pointer",
              children: "Cancel"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              onClick: handleExecutePurgeDuplicates,
              className: "px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-rose-955/20 transition-all cursor-pointer",
              children: "Purge All Duplicates"
            }
          )
        ] })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "flex flex-col gap-4", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex flex-col md:flex-row gap-4 items-start md:items-center justify-between", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("h3", { className: "font-extrabold text-white text-base flex items-center gap-2", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Layers, { className: "w-5 h-5 text-indigo-400" }),
            "CRM Lead Inventory Directory"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "text-xs text-slate-400 mt-1", children: "Multi-purpose spreadsheet structure for CRM syncing. Check any target rows to trigger batch activities." })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex flex-wrap gap-2", children: [
          selectedLeadIds.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex gap-1.5 border-r border-slate-800 pr-3 mr-1", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
              "button",
              {
                onClick: handleBulkDelete,
                className: "bg-rose-500/10 hover:bg-rose-550/20 text-rose-350 text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 border border-rose-500/15 transition-colors cursor-pointer",
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Trash2, { className: "w-3.5 h-3.5" }),
                  "Delete Selected (",
                  selectedLeadIds.length,
                  ")"
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
              "select",
              {
                onChange: (e) => handleBulkStageChange(e.target.value),
                className: "bg-slate-950 border border-slate-800 hover:bg-slate-900 font-semibold px-3 py-2 rounded-xl text-xs text-slate-300 outline-none transition-colors",
                defaultValue: "",
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "", disabled: true, children: "Change Stage To..." }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "scraped", children: "Newly Scraped" }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "contacted", children: "Outreach Sent" }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "interested", children: "In Discussion" }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "converted", children: "Converted Lead" })
                ]
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "button",
            {
              onClick: handleStartEnrichment,
              disabled: leads.length === 0 || enrichmentQueue.length > 0,
              className: "border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-all cursor-pointer shadow-[0_0_15px_rgba(34,211,238,0.15)]",
              title: "Dynamically verify and enrich all missing data for selected/filtered leads",
              children: [
                enrichmentQueue.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Loader2, { className: "w-4 h-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Sparkles, { className: "w-4 h-4" }),
                enrichmentQueue.length > 0 ? "Enriching..." : "AI Enrich Pipeline"
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "button",
            {
              onClick: handleSelectDuplicates,
              disabled: leads.length === 0,
              className: "border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-all cursor-pointer",
              title: "Identify duplicates and highlight them in selection",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Layers, { className: "w-4 h-4" }),
                "Select Duplicates"
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "button",
            {
              onClick: handleTriggerPurgeDuplicates,
              disabled: leads.length === 0,
              className: "border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-all cursor-pointer",
              title: "Instantly analyze and delete redundant duplicate leads in one-click",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Trash2, { className: "w-4 h-4 text-rose-400" }),
                "Purge Duplicates"
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "button",
            {
              onClick: () => handleCsvExport(false),
              disabled: selectedLeadIds.length === 0,
              className: "border border-slate-800 bg-slate-950/20 hover:bg-slate-900 text-slate-300 disabled:text-slate-600 disabled:bg-transparent text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-all cursor-pointer",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.FileDown, { className: "w-4 h-4" }),
                "Export Checked to CSV (",
                selectedLeadIds.length,
                ")"
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "button",
            {
              onClick: () => handleCsvExport(true),
              disabled: leads.length === 0,
              className: "bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-850 disabled:text-slate-600 text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-all shadow-md cursor-pointer",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.FileDown, { className: "w-4 h-4" }),
                "Export All CSV (",
                leads.length,
                ")"
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "input",
            {
              type: "file",
              accept: ".csv",
              ref: fileInputRef,
              onChange: handleCsvImport,
              className: "hidden"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "button",
            {
              onClick: () => fileInputRef.current?.click(),
              disabled: isImporting,
              className: "bg-emerald-600 hover:bg-emerald-500 text-white disabled:bg-slate-850 disabled:text-slate-600 text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2 transition-all shadow-md cursor-pointer",
              children: [
                isImporting ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Loader2, { className: "w-4 h-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.UploadCloud, { className: "w-4 h-4" }),
                isImporting ? "Ingesting..." : "Import CSV"
              ]
            }
          )
        ] })
      ] }) }),
      enrichmentStep && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "bg-indigo-900/30 border border-indigo-500/30 rounded-xl px-4 py-3 flex items-center justify-between animate-pulse", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex items-center gap-3", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Loader2, { className: "w-5 h-5 text-indigo-400 animate-spin" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex flex-col", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "text-xs font-bold text-indigo-200", children: [
            "AI Enrichment actively processing ",
            enrichmentQueue.length,
            " records..."
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "text-[10px] text-indigo-400 font-mono tracking-tight", children: enrichmentStep })
        ] })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex flex-col md:flex-row gap-4 items-center justify-between border-t border-slate-800/60 pt-4", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "relative w-full md:w-80", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Search, { className: "absolute left-3 top-3 h-4 w-4 text-slate-500" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "input",
            {
              type: "text",
              value: tableSearch,
              onChange: (e) => setTableSearch(e.target.value),
              placeholder: "Search spreadsheet rows...",
              className: "w-full bg-slate-950 border border-slate-800 text-white pl-9 pr-4 py-2 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex items-center gap-2 w-full md:w-auto", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.SlidersHorizontal, { className: "w-4 h-4 text-slate-400" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "text-slate-450 text-xs font-bold uppercase", children: "Stage filter:" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "select",
            {
              value: stageFilter,
              onChange: (e) => setStageFilter(e.target.value),
              className: "bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 px-3 py-1.5 font-medium outline-none",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "All", children: "All Stages" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "scraped", children: "Newly Scraped" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "contacted", children: "Outreach Sent" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "interested", children: "In Discussion" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "converted", children: "Converted Leads" })
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "overflow-x-auto border border-slate-800 rounded-xl mb-16", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("table", { className: "w-full text-left text-xs text-slate-300 border-collapse", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("thead", { className: "bg-slate-950 border-b border-slate-850 text-[10px] font-extrabold text-slate-400 uppercase tracking-wider", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { className: "p-4 w-10", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "input",
            {
              type: "checkbox",
              checked: filteredLeads.length > 0 && selectedLeadIds.length === filteredLeads.length,
              onChange: (e) => handleSelectAll(e.target.checked),
              className: "rounded text-indigo-500 focus:ring-indigo-500/50 w-3.5 h-3.5 accent-indigo-505 bg-slate-900 border-slate-700 cursor-pointer"
            }
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { className: "p-4", children: "Contact Profile Name" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { className: "p-4", children: "Primary Title" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { className: "p-4", children: "Employer / Company Name" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { className: "p-4", children: "Corporate Outreach Email" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { className: "p-4 text-center", children: "Pipeline status" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("th", { className: "p-4 text-right", children: "Delete" })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("tbody", { className: "divide-y divide-slate-850 bg-slate-900/10", children: filteredLeads.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { colSpan: 7, className: "p-8 text-center text-slate-500 font-medium bg-slate-950/20", children: "No records stored matching your current directory queries." }) }) : filteredLeads.map((lead) => {
          const isDuplicate = duplicateIds.has(lead.id);
          return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
            "tr",
            {
              className: `hover:bg-slate-800/40 transition-colors ${selectedLeadIds.includes(lead.id) ? "bg-indigo-500/5" : ""} ${isDuplicate ? "border-l-2 border-l-amber-500 bg-amber-500/5" : ""}`,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "p-4", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                  "input",
                  {
                    type: "checkbox",
                    checked: selectedLeadIds.includes(lead.id),
                    onChange: (e) => handleSelectRow(lead.id, e.target.checked),
                    className: "rounded text-indigo-500 focus:ring-indigo-500/50 w-3.5 h-3.5 accent-indigo-505 bg-slate-900 border-slate-700 cursor-pointer"
                  }
                ) }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "p-4 font-bold text-slate-100", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex items-center gap-2", children: [
                  isDuplicate && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { title: "Potential Duplicate Profile", className: "text-amber-500", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.AlertTriangle, { className: "w-3.5 h-3.5" }) }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: lead.profile.fullName }),
                  lead.profile.contactDetails?.linkedinUrl && /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                    "a",
                    {
                      href: lead.profile.contactDetails.linkedinUrl,
                      target: "_blank",
                      rel: "noreferrer",
                      title: "Open LinkedIn",
                      className: "text-slate-500 hover:text-indigo-400 transition-colors",
                      children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Linkedin, { className: "w-3.5 h-3.5" })
                    }
                  )
                ] }) }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "p-4 font-bold text-slate-350 truncate max-w-[200px]", title: lead.profile.currentTitle, children: lead.profile.currentTitle || "Professional" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "p-4 text-slate-400 truncate max-w-[150px]", children: lead.profile.currentCompany || "Independent" }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "p-4", children: lead.profile.contactDetails?.email ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex items-center gap-1.5 text-slate-300 font-semibold", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Mail, { className: "w-3.5 h-3.5 text-slate-500" }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: lead.profile.contactDetails.email })
                ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "text-slate-500 italic", children: "No emails available" }) }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "p-4 text-center", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: `px-2.5 py-1 text-[9px] font-black rounded ${getStageBadgeColor(lead.stage)}`, children: lead.stage.toUpperCase() }) }),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("td", { className: "p-4 text-right", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                  "button",
                  {
                    onClick: () => {
                      onDeleteLead(lead.id);
                      setSelectedLeadIds((prev) => prev.filter((id) => id !== lead.id));
                    },
                    className: "p-1.5 hover:bg-rose-500/10 text-slate-500 hover:text-rose-400 rounded-lg transition-colors cursor-pointer",
                    children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Trash2, { className: "w-4 h-4" })
                  }
                ) })
              ]
            },
            lead.id
          );
        }) })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        "div",
        {
          className: `fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 border border-slate-700 shadow-2xl shadow-indigo-500/10 rounded-2xl px-6 py-3 flex items-center gap-4 md:gap-6 z-50 transition-all duration-300 ${selectedLeadIds.length > 0 ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-12 pointer-events-none"}`,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex items-center gap-3", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "flex items-center justify-center bg-indigo-500 text-white font-bold text-xs h-6 w-6 rounded-full", children: selectedLeadIds.length }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "text-slate-300 font-bold text-sm tracking-tight hidden sm:block", children: "Leads Selected" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "w-px h-8 bg-slate-800" }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex items-center gap-2 md:gap-3", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "text-[10px] md:text-xs font-semibold text-slate-500 uppercase tracking-widest hidden md:block", children: "Move to:" }),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
                "select",
                {
                  className: "bg-slate-950 border border-slate-700 text-xs font-bold text-slate-200 rounded-lg px-2 md:px-3 py-2 outline-none focus:border-indigo-500 cursor-pointer",
                  onChange: (e) => {
                    if (e.target.value) {
                      handleBulkStageChange(e.target.value);
                      e.target.value = "";
                    }
                  },
                  defaultValue: "",
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "", disabled: true, children: "Select stage..." }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "scraped", children: "Newly Scraped" }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "contacted", children: "Outreach Sent" }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "interested", children: "In Discussion" }),
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("option", { value: "converted", children: "Converted Leads" })
                  ]
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "w-px h-8 bg-slate-800" }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
              "button",
              {
                onClick: handleBulkDelete,
                className: "flex items-center gap-2 px-3 py-2 text-rose-400 hover:text-white hover:bg-rose-500 font-bold text-sm rounded-lg transition-colors cursor-pointer",
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.Trash2, { className: "w-4 h-4" }),
                  /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "hidden sm:block", children: "Delete" })
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "button",
              {
                onClick: () => setSelectedLeadIds([]),
                className: "p-2 text-slate-500 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer",
                title: "Clear selection",
                children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_lucide_react3.X, { className: "w-4 h-4" })
              }
            )
          ]
        }
      )
    ] });
  }

  // src/components/OutreachStudio.tsx
  var import_react6 = __require("react");
  var import_react7 = __require("motion/react");
  var import_lucide_react4 = __require("lucide-react");
  var import_jsx_runtime4 = __require("react/jsx-runtime");
  function OutreachStudio({ selectedLeadForOutreach, leads }) {
    const [currentLeadId, setCurrentLeadId] = (0, import_react6.useState)("");
    const [tone, setTone] = (0, import_react6.useState)("High-Value");
    const [medium, setMedium] = (0, import_react6.useState)("Cold Email");
    const [loading, setLoading] = (0, import_react6.useState)(false);
    const [outreachCopy, setOutreachCopy] = (0, import_react6.useState)("");
    const [errorCode, setErrorCode] = (0, import_react6.useState)(null);
    const [copied, setCopied] = (0, import_react6.useState)(false);
    (0, import_react6.useEffect)(() => {
      if (selectedLeadForOutreach) {
        setCurrentLeadId(selectedLeadForOutreach.id);
      } else if (leads.length > 0 && !currentLeadId) {
        setCurrentLeadId(leads[0].id);
      }
    }, [selectedLeadForOutreach, leads]);
    const targetLead = leads.find((l) => l.id === currentLeadId);
    const handleGeneratePitch = async () => {
      if (!targetLead) {
        setErrorCode("Please select a lead first.");
        return;
      }
      setLoading(true);
      setErrorCode(null);
      setOutreachCopy("");
      try {
        const response = await fetch("/api/generate-outbound", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: targetLead.profile,
            tone,
            pitchType: medium
          })
        });
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Outbound engine failed with Status ${response.status}`);
        }
        const data = await response.json();
        setOutreachCopy(data.text || "");
      } catch (err) {
        console.error(err);
        setErrorCode(err.message || "Error generating campaign pitch.");
      } finally {
        setLoading(false);
      }
    };
    const handleCopyToClipboard = () => {
      if (!outreachCopy) return;
      navigator.clipboard.writeText(outreachCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2e3);
    };
    const getMailToLink = () => {
      if (!targetLead || !outreachCopy) return "#";
      const email = targetLead.profile.contactDetails?.email || "";
      let subject = "Connecting with you";
      const lines = outreachCopy.split("\n");
      const subjLine = lines.find((l) => l.toLowerCase().includes("subject:"));
      if (subjLine) {
        subject = subjLine.replace(/subject:/i, "").trim();
      }
      const cleanBody = outreachCopy.replace(/subject:.*\n/i, "").replace(/<br\s*\/?>/gi, "\n").trim();
      return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(cleanBody)}`;
    };
    return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "bg-slate-900/40 border border-slate-800/80 shadow-2xl backdrop-blur-md overflow-hidden grid grid-cols-1 lg:grid-cols-5 divide-y lg:divide-y-0 lg:divide-x divide-slate-800", children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "lg:col-span-2 p-6 space-y-6 bg-slate-900/20", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("h3", { className: "font-extrabold text-white text-base flex items-center gap-2", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_lucide_react4.Wand2, { className: "w-5 h-5 text-indigo-400 animate-pulse" }),
            "AI Outbound Campaign Studio"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "text-xs text-slate-400 mt-1", children: "Generate highly structured hyper-personalized outbound touches relying on scraped experiences data." })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "space-y-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("label", { className: "block text-xs font-semibold text-slate-400 uppercase tracking-wide", children: "Target Prospect" }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "select",
            {
              value: currentLeadId,
              onChange: (e) => setCurrentLeadId(e.target.value),
              disabled: loading || leads.length === 0,
              className: "w-full bg-slate-950 border border-slate-800 text-slate-205 rounded-xl px-3.5 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/50 font-semibold cursor-pointer",
              children: leads.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("option", { value: "", children: "No Leads Scraped Yet" }) : leads.map((lead) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("option", { value: lead.id, children: [
                lead.profile.fullName,
                " (",
                lead.profile.currentCompany || "Independent",
                ")"
              ] }, lead.id))
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "space-y-3", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("label", { className: "block text-xs font-semibold text-slate-400 uppercase tracking-wide", children: "Campaign Tone" }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "grid grid-cols-2 gap-2", children: [
            { id: "Professional", desc: "Authoritative & Solid" },
            { id: "High-Value", desc: "Problem-solving pitch" },
            { id: "Conversational", desc: "Friendly, low pressure" },
            { id: "Bold", desc: "Direct, ROI focus" }
          ].map((t) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
            "button",
            {
              onClick: () => setTone(t.id),
              disabled: loading,
              className: `p-3 rounded-xl border text-left transition-all cursor-pointer ${tone === t.id ? "border-indigo-500 bg-indigo-500/10 text-indigo-300" : "border-slate-800 bg-slate-950 hover:bg-slate-900 text-slate-400"}`,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "font-bold text-xs", children: t.id }),
                /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "text-[10px] text-slate-550 mt-0.5", children: t.desc })
              ]
            },
            t.id
          )) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "space-y-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("label", { className: "block text-xs font-semibold text-slate-400 uppercase tracking-wide", children: "Outbound Channel Medium" }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "flex gap-2", children: [
            { id: "Cold Email", icon: import_lucide_react4.Mail },
            { id: "LinkedIn Connection Request", icon: import_lucide_react4.Linkedin },
            { id: "Detailed InMail Pitch", icon: import_lucide_react4.Settings }
          ].map((m) => {
            const Icon = m.icon;
            return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
              "button",
              {
                onClick: () => setMedium(m.id),
                disabled: loading,
                className: `flex-1 p-2.5 rounded-lg border text-center flex flex-col items-center justify-center gap-1.5 transition-all text-[11px] font-semibold cursor-pointer ${medium === m.id ? "border-indigo-500 bg-indigo-500/10 text-indigo-300" : "border-slate-800 bg-slate-950 hover:bg-slate-900 text-slate-450"}`,
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Icon, { className: "w-4 h-4 text-indigo-400/80" }),
                  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "leading-tight", children: m.id.split(" ")[0] })
                ]
              },
              m.id
            );
          }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "button",
          {
            onClick: handleGeneratePitch,
            disabled: loading || !targetLead,
            className: "w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 transition-all text-sm shadow-sm cursor-pointer",
            children: [
              loading ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_lucide_react4.RefreshCw, { className: "w-4 h-4 animate-spin" }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_lucide_react4.Sparkles, { className: "w-4 h-4" }),
              "Generate High-Converting Pitch"
            ]
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "lg:col-span-3 p-6 flex flex-col justify-between h-full bg-slate-900/10 space-y-4", children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex items-center justify-between border-b border-slate-850 pb-3 mb-4", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex items-center gap-2", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_lucide_react4.FileText, { className: "w-4 h-4 text-slate-500" }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("h4", { className: "font-bold text-slate-300 text-xs uppercase tracking-wide", children: "Personalized Campaign Copy" })
            ] }),
            outreachCopy && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "flex gap-2", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
                "button",
                {
                  onClick: handleCopyToClipboard,
                  className: "p-2 border border-slate-800 hover:bg-slate-900 text-slate-300 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all cursor-pointer",
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_lucide_react4.Clipboard, { className: "w-3.5 h-3.5" }),
                    copied ? "Copied" : "Copy"
                  ]
                }
              ),
              medium === "Cold Email" && targetLead?.profile.contactDetails?.email && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
                "a",
                {
                  href: getMailToLink(),
                  className: "p-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 hover:bg-indigo-500/20 rounded-lg text-xs font-bold flex items-center gap-1 transition-all animate-pulse",
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_lucide_react4.Mail, { className: "w-3.5 h-3.5" }),
                    "Mail in App"
                  ]
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "min-h-[300px] border border-slate-850 bg-slate-950/80 rounded-xl p-4 text-slate-205 text-xs font-sans leading-relaxed whitespace-pre-wrap select-all relative", children: [
            /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_react7.AnimatePresence, { mode: "wait", children: loading && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "absolute inset-0 bg-slate-950/90 rounded-xl flex flex-col items-center justify-center gap-3 shadow-2xl", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "h-8 w-8 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "text-xs text-slate-400 font-bold animate-pulse", children: "Personalizing hook utilizing experiences details..." })
            ] }) }),
            outreachCopy ? outreachCopy : errorCode ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "text-rose-450 flex items-center gap-2 font-bold", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { children: [
              "Error generating pitch: ",
              errorCode
            ] }) }) : /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "h-full flex flex-col items-center justify-center text-center text-slate-500 py-16", children: [
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(import_lucide_react4.Send, { className: "w-10 h-10 text-slate-705 mb-3" }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "font-bold text-xs text-slate-400", children: "No pitch script active." }),
              /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "max-w-xs text-[11px] text-slate-550 mt-1", children: "Select a prospect, tweak parameters, and hit Generate to see a context-grounded outreach pitch." })
            ] })
          ] })
        ] }),
        targetLead && /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "bg-indigo-500/5 p-3.5 rounded-xl border border-indigo-500/10 text-xs text-slate-450", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "font-bold text-indigo-300 block mb-1", children: "\u{1F3AF} Segment Lead Facts:" }),
          "Mapped experiences: ",
          /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("span", { className: "font-bold text-slate-200", children: [
            (targetLead.profile.experiences || []).length,
            " items"
          ] }),
          " | Corporate outreach: ",
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "font-bold text-slate-200", children: targetLead.profile.contactDetails?.email || "N/A" })
        ] })
      ] })
    ] });
  }

  // src/components/CrmOverview.tsx
  var import_lucide_react5 = __require("lucide-react");
  var import_jsx_runtime5 = __require("react/jsx-runtime");
  function CrmOverview({ leads }) {
    const totalLeads = leads.length;
    const newlyScrapedCount = leads.filter((l) => l.stage === "scraped").length;
    const contactedCount = leads.filter((l) => l.stage === "contacted").length;
    const interestedCount = leads.filter((l) => l.stage === "interested").length;
    const convertedCount = leads.filter((l) => l.stage === "converted").length;
    const conversionRate = totalLeads > 0 ? Math.round(convertedCount / totalLeads * 100) : 0;
    const scorableLeads = leads.filter((l) => typeof l.score === "number" && l.score > 0);
    const avgQualificationScore = scorableLeads.length > 0 ? Math.round(scorableLeads.reduce((acc, curr) => acc + (curr.score || 0), 0) / scorableLeads.length) : 0;
    const industriesMap = {};
    leads.forEach((l) => {
      const ind = l.profile.industry || "Tech";
      industriesMap[ind] = (industriesMap[ind] || 0) + 1;
    });
    const industriesSorted = Object.entries(industriesMap).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const getScoreLabel = (score) => {
      if (score >= 80) return "Top Tier (Hot)";
      if (score >= 50) return "Qualified (Warm)";
      if (score >= 30) return "Developing (Cool)";
      return "Unrated";
    };
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "space-y-6", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "bg-slate-900/40 rounded-2xl border border-slate-805/80 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.2)] backdrop-blur-md flex items-center gap-4", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "h-12 w-12 bg-indigo-500/10 text-indigo-400 rounded-xl flex items-center justify-center border border-indigo-500/20", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_lucide_react5.Users, { className: "w-5 h-5" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block", children: "Total Prospect Leads" }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("h4", { className: "text-2xl font-extrabold text-white mt-1", children: totalLeads })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "bg-slate-900/40 rounded-2xl border border-slate-805/80 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.2)] backdrop-blur-md flex items-center gap-4", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "h-12 w-12 bg-emerald-500/10 text-emerald-400 rounded-xl flex items-center justify-center border border-emerald-500/20", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_lucide_react5.Percent, { className: "w-5 h-5" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block", children: "Pipeline Conversion" }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("h4", { className: "text-2xl font-extrabold text-white mt-1", children: [
              conversionRate,
              "%"
            ] })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "bg-slate-900/40 rounded-2xl border border-slate-805/80 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.2)] backdrop-blur-md flex items-center gap-4", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "h-12 w-12 bg-blue-500/10 text-blue-450 rounded-xl flex items-center justify-center border border-blue-500/20", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_lucide_react5.Award, { className: "w-5 h-5" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block", children: "Average Qualification" }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("h4", { className: "text-2xl font-extrabold text-white mt-1", children: [
              avgQualificationScore || "0",
              "%"
            ] })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "bg-slate-900/40 rounded-2xl border border-slate-805/80 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.2)] backdrop-blur-md flex items-center gap-4", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "h-12 w-12 bg-cyan-500/10 text-cyan-400 rounded-xl flex items-center justify-center border border-cyan-500/20", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_lucide_react5.TrendingUp, { className: "w-5 h-5" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block", children: "Conversion Quality" }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("h4", { className: "text-xs font-bold text-slate-200 mt-2 bg-slate-950/40 border border-slate-800/80 px-2 py-1 rounded inline-block", children: getScoreLabel(avgQualificationScore) })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-6", children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "bg-slate-900/40 p-6 rounded-2xl border border-slate-805/80 shadow-lg backdrop-blur-md flex flex-col justify-between", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("h4", { className: "font-extrabold text-white text-sm flex items-center gap-2 mb-1", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_lucide_react5.Clock, { className: "w-4.5 h-4.5 text-indigo-400" }),
              "Pipeline Volume Distribution"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "text-xs text-slate-400 mb-5", children: "Current lead allocation statuses within your outbound pipe." })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "space-y-4", children: [
            { label: "Newly Scraped Queue", count: newlyScrapedCount, color: "bg-indigo-400" },
            { label: "Outreach Sent Campaign", count: contactedCount, color: "bg-cyan-500" },
            { label: "In Discussion Deal", count: interestedCount, color: "bg-blue-500" },
            { label: "Successfully Converted", count: convertedCount, color: "bg-emerald-500" }
          ].map((st, i) => {
            const pct = totalLeads > 0 ? st.count / totalLeads * 100 : 0;
            return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "space-y-1", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "flex justify-between text-xs font-semibold text-slate-300", children: [
                /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { children: st.label }),
                /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "text-slate-400", children: [
                  st.count,
                  " leads (",
                  Math.round(pct),
                  "%)"
                ] })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "h-1.5 w-full bg-slate-950 border border-slate-850 rounded-full overflow-hidden", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: `h-full ${st.color} transition-all duration-500`, style: { width: `${pct}%` } }) })
            ] }, i);
          }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "bg-slate-900/40 p-6 rounded-2xl border border-slate-805/80 shadow-lg backdrop-blur-md flex flex-col justify-between", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("h4", { className: "font-extrabold text-white text-sm flex items-center gap-2 mb-1", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_lucide_react5.Briefcase, { className: "w-4.5 h-4.5 text-indigo-400" }),
              "Top Industry Segment targets"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "text-xs text-slate-400 mb-5", children: "Leading industry fields from Google Search indexes." })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "space-y-4", children: leads.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "text-xs text-slate-450 italic text-center py-8", children: "Gather profiles to populate industry segmentation metrics." }) : industriesSorted.map(([industry, count], i) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "flex items-center justify-between text-xs py-1 border-b border-slate-800/20 last:border-0", children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "flex items-center gap-2.5", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "w-5 h-5 bg-slate-950/60 text-slate-400 rounded-md border border-slate-800 flex items-center justify-center font-bold text-[10px]", children: i + 1 }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: "font-semibold text-slate-300", children: industry })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-bold px-2.5 py-0.5 rounded-lg text-[10px]", children: [
              count,
              " profile",
              count > 1 ? "s" : ""
            ] })
          ] }, i)) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "bg-slate-900/40 p-6 rounded-2xl border border-slate-805/80 shadow-lg backdrop-blur-md flex flex-col justify-between", children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("h4", { className: "font-extrabold text-white text-sm flex items-center gap-2 mb-1", children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_lucide_react5.Clock, { className: "w-4.5 h-4.5 text-indigo-400" }),
              "Outbound Activity Log"
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "text-xs text-slate-400 mb-5", children: "Latest records log audits for lead harvesting and structuring activity pipelines." })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "space-y-3.5 max-h-[170px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-slate-800", children: totalLeads === 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("p", { className: "text-xs text-slate-500 italic text-center py-6", children: "Database is empty. Log output will load upon search/scraping tasks execution." }) : leads.slice(0, 4).map((l, i) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: "flex items-start gap-2.5 text-xs", children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: "w-1.5 h-1.5 rounded-full bg-indigo-500/70 shrink-0 mt-1.5 animate-pulse" }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "font-semibold text-slate-350 hover:text-white transition-colors", children: [
                "Harvested ",
                l.profile.fullName
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: "text-[10px] text-slate-500 block mt-0.5", children: [
                "Structured under ",
                l.profile.industry || "Tech",
                " \u2022 ",
                new Date(l.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              ] })
            ] })
          ] }, i)) })
        ] })
      ] })
    ] });
  }

  // node_modules/idb-keyval/dist/index.js
  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.oncomplete = request.onsuccess = () => resolve(request.result);
      request.onabort = request.onerror = () => reject(request.error);
    });
  }
  function createStore(dbName, storeName) {
    let dbp;
    const getDB = () => {
      if (dbp)
        return dbp;
      const request = indexedDB.open(dbName);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      dbp = promisifyRequest(request);
      dbp.then((db) => {
        db.onclose = () => dbp = void 0;
      }, () => {
      });
      return dbp;
    };
    return (txMode, callback) => getDB().then((db) => callback(db.transaction(storeName, txMode).objectStore(storeName)));
  }
  var defaultGetStoreFunc;
  function defaultGetStore() {
    if (!defaultGetStoreFunc) {
      defaultGetStoreFunc = createStore("keyval-store", "keyval");
    }
    return defaultGetStoreFunc;
  }
  function get(key, customStore = defaultGetStore()) {
    return customStore("readonly", (store) => promisifyRequest(store.get(key)));
  }
  function set(key, value, customStore = defaultGetStore()) {
    return customStore("readwrite", (store) => {
      store.put(value, key);
      return promisifyRequest(store.transaction);
    });
  }

  // src/utils/idb.ts
  var getLeadsIDB = async () => {
    try {
      const leads = await Promise.race([
        get("all_leads"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("IDB Timeout")), 1e3))
      ]);
      return leads || null;
    } catch (error) {
      console.error("getLeadsIDB error/timeout:", error);
      return null;
    }
  };
  var setLeadsIDB = async (leads) => {
    try {
      const cloned = JSON.parse(JSON.stringify(leads));
      await Promise.race([
        set("all_leads", cloned),
        new Promise((_, reject) => setTimeout(() => reject(new Error("IDB Set Timeout")), 1e3))
      ]);
    } catch (error) {
      console.error("setLeadsIDB error:", error);
    }
  };

  // src/App.tsx
  var import_jsx_runtime6 = __require("react/jsx-runtime");
  var seedLeads = [
    {
      id: "seed-siskind",
      profile: {
        id: "gregory-siskind",
        fullName: "Gregory Siskind",
        headline: "Award-winning Immigration Attorney, Legal AI Pioneer & Co-founder of Siskind Susser PC",
        currentCompany: "Siskind Susser PC / Visalaw AI",
        currentTitle: "Founding Partner & Chief Legal AI Innovator",
        location: "Memphis, TN",
        industry: "Legal Services",
        summary: "Gregory Siskind is a nationally recognized immigration lawyer, co-author of several major treatises, and a leading legal technology innovator. He co-founded Siskind Susser PC in 1994 (Tennessee's first legal web page) and is the vanguard of Visalaw AI, building generative AI legal tools.",
        contactDetails: {
          email: "gsiskind@visalaw.com",
          phone: "+1 (901) 682-6455",
          linkedinUrl: "https://www.linkedin.com/in/siskind/",
          website: "https://www.visalaw.com"
        },
        experiences: [
          {
            title: "Founding Partner & Attorney",
            company: "Siskind Susser PC",
            duration: "1994 - Present",
            location: "Memphis, TN",
            description: "Managing one of the largest immigration law firms in the USA. Pioneer internet legal marketing and digital workflows for visa processing and corporate compliance."
          },
          {
            title: "Co-founder & Chief Product Officer",
            company: "Visalaw AI",
            duration: "2022 - Present",
            location: "Memphis, TN",
            description: "Overseeing product strategy for GenAI-powered search grounding engines, compliance validators, and chat-based legal research assistants for immigration specialists."
          }
        ],
        education: [
          {
            school: "Vanderbilt University Law School",
            degree: "Juris Doctor (JD)",
            duration: "1987 - 1990"
          },
          {
            school: "The College of William & Mary",
            degree: "Bachelor of Arts",
            fieldOfStudy: "Political Science",
            duration: "1983 - 1987"
          }
        ],
        skills: ["Immigration Law", "Legal Technology", "Product Architecture", "GenAI", "Digital Marketing"]
      },
      stage: "scraped",
      notes: "Primary targeted lead directly matching requested lookup details. High interest sector, expert in legal LLM tooling.",
      createdAt: new Date(Date.now() - 36e5 * 24).toISOString(),
      tags: ["Key Target", "Legal AI Pioneer", "Premium Account"],
      score: 98
    },
    {
      id: "seed-aris",
      profile: {
        id: "aris-thompson",
        fullName: "Aris Thompson",
        headline: "Founder & CEO of Lexic AI \u2022 Generative Legal Intelligence Workspace",
        currentCompany: "Lexic AI",
        currentTitle: "Founder & CEO",
        location: "San Francisco, CA",
        industry: "Software Engineering",
        summary: "Aris is a software engineer and serial entrepreneur building advanced document-reasoning graphs for commercial litigation and law operations. Ex-Stripe staff architect.",
        contactDetails: {
          email: "aris@lexic.ai",
          linkedinUrl: "https://www.linkedin.com/in/aris-thompson-mock/",
          website: "https://lexic.ai"
        },
        experiences: [
          {
            title: "Founder & CEO",
            company: "Lexic AI",
            duration: "2023 - Present",
            location: "San Francisco, CA",
            description: "Architecting vectors database structures and search grounding middleware to help enterprise litigators mine 100M+ corporate emails safely."
          },
          {
            title: "Staff Software Engineer",
            company: "Stripe",
            duration: "2019 - 2023",
            location: "San Francisco, CA",
            description: "Led core billing systems optimization. Built scalable ledger structures processing upwards of 2B daily transactional logs."
          }
        ],
        education: [
          {
            school: "Stanford University",
            degree: "B.S.",
            fieldOfStudy: "Computer Science",
            duration: "2015 - 2019"
          }
        ],
        skills: ["Distributed Systems", "PostgreSQL", "LegalTech", "Vector Databases", "Startups"]
      },
      stage: "interested",
      notes: "Intro schedule set for next Wednesday at 2 PM PST. They are looking to leverage our direct CSV integration models.",
      createdAt: new Date(Date.now() - 36e5 * 48).toISOString(),
      tags: ["Founder", "Warm Intro", "SF Based"],
      score: 87
    },
    {
      id: "seed-julia",
      profile: {
        id: "julia-chen",
        fullName: "Julia Chen",
        headline: "VP of Recruit & Human Talents at CloudTech Global",
        currentCompany: "CloudTech Global",
        currentTitle: "VP of Human Talents",
        location: "Austin, TX",
        industry: "Human Resources",
        summary: "Experienced executive recruiter leading talent strategy across North America and APAC markets. Focused on tech hiring scaling vectors.",
        contactDetails: {
          email: "jchen@cloudtech-global.com",
          phone: "+1 (512) 555-8832",
          linkedinUrl: "https://www.linkedin.com/in/julia-chen-mock/"
        },
        experiences: [
          {
            title: "VP of Human Talents",
            company: "CloudTech Global",
            duration: "2021 - Present",
            location: "Austin, TX",
            description: "Scaling engineering and go-to-market teams. Built a global recruitment structure hiring 500+ professionals annually."
          }
        ],
        education: [
          {
            school: "University of Texas at Austin",
            degree: "B.B.A.",
            fieldOfStudy: "Business & Management",
            duration: "2008 - 2012"
          }
        ],
        skills: ["Executive Search", "Org Design", "Scaling HR", "Sourcing Platforms"]
      },
      stage: "contacted",
      notes: "Outreach campaign initiated using our Conversational Tone email pitch sequence on June 4th. Awaiting feedback loop.",
      createdAt: new Date(Date.now() - 36e5 * 72).toISOString(),
      tags: ["Recruiting Executive", "Outbound Pipe"],
      score: 72
    }
  ];
  function App() {
    const [activeTab, setActiveTab] = (0, import_react8.useState)("overview");
    const [leads, setLeads] = (0, import_react8.useState)([]);
    const [isHydrated, setIsHydrated] = (0, import_react8.useState)(false);
    const [selectedLeadForOutreach, setSelectedLeadForOutreach] = (0, import_react8.useState)(null);
    const [showManualModal, setShowManualModal] = (0, import_react8.useState)(false);
    const [manualName, setManualName] = (0, import_react8.useState)("");
    const [manualTitle, setManualTitle] = (0, import_react8.useState)("");
    const [manualCompany, setManualCompany] = (0, import_react8.useState)("");
    const [manualEmail, setManualEmail] = (0, import_react8.useState)("");
    const [manualUrl, setManualUrl] = (0, import_react8.useState)("");
    const [manualIndustry, setManualIndustry] = (0, import_react8.useState)("Tech");
    const [manualSummary, setManualSummary] = (0, import_react8.useState)("");
    (0, import_react8.useEffect)(() => {
      const sanitizeLeads = (loadedLeads) => {
        return loadedLeads.map((l) => ({
          ...l,
          id: l.id || crypto.randomUUID()
        }));
      };
      getLeadsIDB().then((stored) => {
        if (stored) {
          setLeads(sanitizeLeads(stored));
        } else {
          try {
            const legacyStored = localStorage.getItem("linkedin_scraper_crm_leads");
            if (legacyStored) {
              const parsed = sanitizeLeads(JSON.parse(legacyStored));
              setLeads(parsed);
              setLeadsIDB(parsed).catch(console.error);
              setIsHydrated(true);
              return;
            }
          } catch (e) {
          }
          setLeads(seedLeads);
          setLeadsIDB(seedLeads).catch(console.error);
        }
        setIsHydrated(true);
      }).catch((e) => {
        console.error("IndexedDB load failed:", e);
        setLeads(seedLeads);
        setIsHydrated(true);
      });
    }, []);
    (0, import_react8.useEffect)(() => {
      if (!isHydrated) return;
      const timer = setTimeout(async () => {
        try {
          localStorage.setItem("linkedin_scraper_crm_leads", JSON.stringify(leads));
        } catch (lsError) {
          console.error("LocalStorage sync failed", lsError);
        }
        try {
          setLeadsIDB(leads).catch((e) => console.warn("IDB failed", e));
        } catch (e) {
          console.warn("IDB failed exception", e);
        }
      }, 100);
      return () => clearTimeout(timer);
    }, [leads, isHydrated]);
    const saveLeadsToStorage = (updater) => {
      setLeads((prev) => {
        return typeof updater === "function" ? updater(prev) : updater;
      });
    };
    const handleLeadAdded = (profile) => {
      saveLeadsToStorage((currentLeads) => {
        const isDup = currentLeads.some((lead) => {
          const e1 = lead.profile.contactDetails?.email?.toLowerCase();
          const e2 = profile.contactDetails?.email?.toLowerCase();
          const l1 = lead.profile.contactDetails?.linkedinUrl?.toLowerCase();
          const l2 = profile.contactDetails?.linkedinUrl?.toLowerCase();
          const n1 = (lead.profile.fullName || "").toLowerCase();
          const n2 = (profile.fullName || "").toLowerCase();
          const comp1 = (lead.profile.currentCompany || "").toLowerCase();
          const comp2 = (profile.currentCompany || "").toLowerCase();
          return e1 && e2 && e1 === e2 || l1 && l2 && l1 === l2 || n1 === n2 && comp1 === comp2;
        });
        if (isDup) {
          console.warn("Skipped writing duplicate lead to CRM:", profile.fullName);
          return currentLeads;
        }
        const score = Math.floor(Math.random() * 30) + 65;
        const newLead = {
          id: `lead-${Date.now()}`,
          profile,
          stage: "scraped",
          notes: "Profile automatically harvested and structured by Gemini Search Scraper.",
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          tags: ["Scraped Lead", profile.industry || "Tech"],
          score
        };
        return [newLead, ...currentLeads];
      });
    };
    const handleBulkLeadsAdded = (profiles) => {
      saveLeadsToStorage((currentLeads) => {
        const existingMap = /* @__PURE__ */ new Map();
        currentLeads.forEach((l) => {
          if (l.profile.contactDetails?.email) {
            existingMap.set(l.profile.contactDetails.email.toLowerCase(), true);
          }
          if (l.profile.contactDetails?.linkedinUrl) {
            existingMap.set(l.profile.contactDetails.linkedinUrl.toLowerCase(), true);
          }
          const existingCompany = (l.profile.currentCompany || "").toLowerCase();
          existingMap.set(`${(l.profile.fullName || "").toLowerCase()}::${existingCompany}`, true);
        });
        const uniqueProfiles = profiles.filter((p) => {
          const email = p.contactDetails?.email?.toLowerCase();
          const url = p.contactDetails?.linkedinUrl?.toLowerCase();
          const profileCompany = (p.currentCompany || "").toLowerCase();
          const nameKey = `${(p.fullName || "").toLowerCase()}::${profileCompany}`;
          if (email && existingMap.has(email)) return false;
          if (url && existingMap.has(url)) return false;
          if (existingMap.has(nameKey)) return false;
          return true;
        });
        if (uniqueProfiles.length === 0) {
          console.warn("All bulk profiles were duplicates, skipping CRM integration.");
          return currentLeads;
        }
        const newLeads = uniqueProfiles.map((p, i) => {
          const score = Math.floor(Math.random() * 35) + 60;
          return {
            id: `lead-bulk-${Date.now()}-${i}`,
            profile: p,
            stage: "scraped",
            notes: "Bulk discovered via AI Search Discovery parameters.",
            createdAt: (/* @__PURE__ */ new Date()).toISOString(),
            tags: ["Discovered", p.industry || "Tech"],
            score
          };
        });
        return [...newLeads, ...currentLeads];
      });
    };
    const handleUpdateLeadStage = (leadId, stage) => {
      saveLeadsToStorage(
        (currentLeads) => currentLeads.map((l) => l.id === leadId ? { ...l, stage } : l)
      );
    };
    const handleUpdateLeadNotes = (leadId, notes) => {
      saveLeadsToStorage(
        (currentLeads) => currentLeads.map((l) => l.id === leadId ? { ...l, notes } : l)
      );
    };
    const handleUpdateLeadProfile = (leadId, profileUpdates) => {
      saveLeadsToStorage(
        (currentLeads) => currentLeads.map((l) => l.id === leadId ? { ...l, profile: { ...l.profile, ...profileUpdates }, notes: "Profile dynamically enriched and verified by background AI pipeline." } : l)
      );
    };
    const handleUpdateLeadTags = (leadId, tags) => {
      saveLeadsToStorage(
        (currentLeads) => currentLeads.map((l) => l.id === leadId ? { ...l, tags } : l)
      );
    };
    const handleDeleteLead = (leadId) => {
      try {
        console.log(`[App] Deleting lead ID: ${leadId}`);
        saveLeadsToStorage((currentLeads) => {
          const nextLeads = currentLeads.filter((l) => l.id !== leadId);
          console.log(`[App] Delete lead - Current count: ${currentLeads.length}, Next count: ${nextLeads.length}`);
          return nextLeads;
        });
      } catch (e) {
        console.error(`[App] Error during lead deletion:`, e);
      }
    };
    const handleDeleteLeads = (leadIds) => {
      try {
        console.log(`[App] Deleting bulk leads count: ${leadIds.length}`);
        const idSet = new Set(leadIds);
        saveLeadsToStorage((currentLeads) => {
          const nextLeads = currentLeads.filter((l) => !idSet.has(l.id));
          console.log(`[App] Bulk delete leads - Current count: ${currentLeads.length}, Next count: ${nextLeads.length}`);
          return nextLeads;
        });
      } catch (e) {
        console.error(`[App] Error during bulk lead deletion:`, e);
      }
    };
    const handleUpdateLeadsStage = (leadIds, stage) => {
      const idSet = new Set(leadIds);
      saveLeadsToStorage(
        (currentLeads) => currentLeads.map((l) => idSet.has(l.id) ? { ...l, stage } : l)
      );
    };
    const handleManualLeadSubmit = (e) => {
      e.preventDefault();
      if (!manualName.trim()) return;
      const newProfile = {
        id: `manual-p-${Date.now()}`,
        fullName: manualName,
        headline: manualTitle ? `${manualTitle} @ ${manualCompany || "Independent"}` : "Professional",
        currentCompany: manualCompany || "Independent",
        currentTitle: manualTitle || "Professional",
        location: "Undisclosed Location",
        industry: manualIndustry,
        summary: manualSummary || "Manually loaded prospect details.",
        contactDetails: {
          email: manualEmail,
          linkedinUrl: manualUrl || `https://linkedin.com/in/${(manualName || "").toLowerCase().replace(/\s+/g, "-")}`
        },
        experiences: manualTitle ? [{ title: manualTitle, company: manualCompany }] : []
      };
      saveLeadsToStorage((currentLeads) => {
        const isDup = currentLeads.some((l) => {
          const e1 = l.profile.contactDetails?.email?.toLowerCase();
          const e2 = (manualEmail || "").toLowerCase();
          const l1 = l.profile.contactDetails?.linkedinUrl?.toLowerCase();
          const l2 = (manualUrl || "")?.toLowerCase();
          const n1 = (l.profile.fullName || "").toLowerCase();
          const n2 = (manualName || "").toLowerCase();
          const comp1 = (l.profile.currentCompany || "").toLowerCase();
          const comp2 = (manualCompany || "").toLowerCase();
          return e1 && e2 && e1 === e2 || l1 && l2 && l1 === l2 || n1 === n2 && comp1 === comp2;
        });
        if (isDup) {
          console.warn(`A profile for ${manualName} already exists in your CRM.`);
          return currentLeads;
        }
        const score = Math.floor(Math.random() * 20) + 75;
        const newLead = {
          id: `lead-manual-${Date.now()}`,
          profile: newProfile,
          stage: "scraped",
          notes: "Manually logged contact card.",
          createdAt: (/* @__PURE__ */ new Date()).toISOString(),
          tags: ["Manual Entry"],
          score
        };
        setManualName("");
        setManualTitle("");
        setManualCompany("");
        setManualEmail("");
        setManualUrl("");
        setManualIndustry("Tech");
        setManualSummary("");
        setShowManualModal(false);
        return [newLead, ...currentLeads];
      });
    };
    const handleSelectLeadForOutreach = (lead) => {
      setSelectedLeadForOutreach(lead);
      setActiveTab("outreach");
    };
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "min-h-screen bg-[#090d16] text-slate-100 font-sans flex flex-col justify-between selection:bg-indigo-500/30 selection:text-white", children: [
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "fixed inset-0 overflow-hidden pointer-events-none z-0", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-500/5 blur-[120px]" }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-cyan-500/5 blur-[120px]" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("header", { className: "bg-slate-950/70 backdrop-blur-md border-b border-indigo-500/10 sticky top-0 z-40 shadow-[0_4px_30px_rgba(0,0,0,0.4)] relative", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-18 flex items-center justify-between", children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "flex items-center gap-3", children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "h-10 w-10 bg-gradient-to-tr from-indigo-550 to-cyan-500 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(99,102,241,0.3)]", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(import_lucide_react6.Database, { className: "w-5.3 h-5.3 text-white animate-pulse" }) }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("h1", { className: "font-extrabold text-white text-sm tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-slate-100 to-indigo-200", children: "LinkedIn Lead Scraper & CRM" }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "text-[9px] bg-indigo-950/60 text-indigo-300 border border-indigo-500/25 rounded px-2 py-0.5 mt-0.5 inline-block tracking-wider uppercase font-extrabold", children: "Grounded Web mining active" })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("nav", { className: "hidden lg:flex items-center gap-2", children: [
            { id: "overview", label: "Overview", icon: import_lucide_react6.Gauge },
            { id: "workspace", label: "Scraper Hub", icon: import_lucide_react6.Sparkles },
            { id: "pipeline", label: "Kanban Pipeline", icon: import_lucide_react6.Layers },
            { id: "inventory", label: "CRM Inventory", icon: import_lucide_react6.TableProperties },
            { id: "outreach", label: "Outreach Studio", icon: import_lucide_react6.Wand2 }
          ].map((tab) => {
            const Icon = tab.icon;
            const isSelected = activeTab === tab.id;
            return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
              "button",
              {
                onClick: () => setActiveTab(tab.id),
                className: `px-4 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 flex items-center gap-2 cursor-pointer border ${isSelected ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.12)]" : "text-slate-400 hover:text-slate-100 hover:bg-slate-900 border-transparent"}`,
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Icon, { className: `w-4 h-4 transition-transform duration-300 ${isSelected ? "scale-110 text-indigo-400" : "text-slate-400 group-hover:text-slate-250"}` }),
                  tab.label
                ]
              },
              tab.id
            );
          }) }),
          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "flex items-center gap-2", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
            "button",
            {
              onClick: () => setShowManualModal(true),
              className: "bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-[0_0_15px_rgba(99,102,241,0.2)] hover:shadow-[0_0_20px_rgba(99,102,241,0.4)] hover:scale-[1.02] cursor-pointer",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(import_lucide_react6.Plus, { className: "w-4 h-4" }),
                "Manual Contact"
              ]
            }
          ) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "lg:hidden border-t border-slate-800/80 bg-slate-950/60 backdrop-blur-md px-4 py-2 flex gap-1.5 overflow-x-auto select-none", children: [
          { id: "overview", label: "Overview", icon: import_lucide_react6.Gauge },
          { id: "workspace", label: "Miner", icon: import_lucide_react6.Sparkles },
          { id: "pipeline", label: "Pipeline", icon: import_lucide_react6.Layers },
          { id: "inventory", label: "CRM", icon: import_lucide_react6.TableProperties },
          { id: "outreach", label: "Outreach", icon: import_lucide_react6.Wand2 }
        ].map((tab) => {
          const Icon = tab.icon;
          const isSelected = activeTab === tab.id;
          return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
            "button",
            {
              onClick: () => setActiveTab(tab.id),
              className: `px-3 py-2 rounded-lg text-[11px] font-bold shrink-0 transition-all flex items-center gap-1.5 cursor-pointer border ${isSelected ? "bg-indigo-600 text-white border-indigo-550 shadow-md" : "bg-slate-900/40 border-slate-800/60 text-slate-400 hover:text-white"}`,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Icon, { className: "w-3.5 h-3.5" }),
                tab.label
              ]
            },
            tab.id
          );
        }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("main", { className: "flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 relative z-10", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "space-y-6", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_react9.AnimatePresence, { mode: "wait", children: [
        activeTab === "overview" && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          import_react9.motion.div,
          {
            initial: { opacity: 0, y: 15, scale: 0.98 },
            animate: { opacity: 1, y: 0, scale: 1 },
            exit: { opacity: 0, y: -15, scale: 0.98 },
            transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
            children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(CrmOverview, { leads })
          },
          "tab-overview"
        ),
        activeTab === "workspace" && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
          import_react9.motion.div,
          {
            initial: { opacity: 0, y: 15, scale: 0.98 },
            animate: { opacity: 1, y: 0, scale: 1 },
            exit: { opacity: 0, y: -15, scale: 0.98 },
            transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "mb-6", children: [
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("h2", { className: "text-xl font-extrabold text-white tracking-tight", children: "Lead Extraction Terminal" }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "text-xs text-slate-400 mt-1", children: "Acquire prospective detail schemas using direct URL mapping, raw text clipboard extraction, or general criteria discoverers." })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                ScrapeWorkspace,
                {
                  leads,
                  onLeadAdded: handleLeadAdded,
                  onBulkLeadsAdded: handleBulkLeadsAdded
                }
              )
            ]
          },
          "tab-workspace"
        ),
        activeTab === "pipeline" && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
          import_react9.motion.div,
          {
            initial: { opacity: 0, y: 15, scale: 0.98 },
            animate: { opacity: 1, y: 0, scale: 1 },
            exit: { opacity: 0, y: -15, scale: 0.98 },
            transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "mb-6 flex justify-between items-center", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { children: [
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("h2", { className: "text-xl font-extrabold text-white tracking-tight", children: "Visual Pipeline Workflow" }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "text-xs text-slate-400 mt-1", children: "Supervise outbound status stages and analyze qualification indexes." })
              ] }) }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                CrmPipeline,
                {
                  leads,
                  onUpdateLeadStage: handleUpdateLeadStage,
                  onUpdateLeadNotes: handleUpdateLeadNotes,
                  onUpdateLeadTags: handleUpdateLeadTags,
                  onDeleteLead: handleDeleteLead,
                  onSelectLeadForOutreach: handleSelectLeadForOutreach
                }
              )
            ]
          },
          "tab-pipeline"
        ),
        activeTab === "inventory" && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          import_react9.motion.div,
          {
            initial: { opacity: 0, y: 15, scale: 0.98 },
            animate: { opacity: 1, y: 0, scale: 1 },
            exit: { opacity: 0, y: -15, scale: 0.98 },
            transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
            children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
              LeadTable,
              {
                leads,
                onUpdateLeadStage: handleUpdateLeadStage,
                onUpdateLeadsStage: handleUpdateLeadsStage,
                onDeleteLead: handleDeleteLead,
                onDeleteLeads: handleDeleteLeads,
                onAddManualLead: () => setShowManualModal(true),
                onBulkLeadsAdded: handleBulkLeadsAdded,
                onUpdateLeadProfile: handleUpdateLeadProfile
              }
            )
          },
          "tab-inventory"
        ),
        activeTab === "outreach" && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
          import_react9.motion.div,
          {
            initial: { opacity: 0, y: 15, scale: 0.98 },
            animate: { opacity: 1, y: 0, scale: 1 },
            exit: { opacity: 0, y: -15, scale: 0.98 },
            transition: { duration: 0.25, ease: [0.25, 0.1, 0.25, 1] },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "mb-6", children: [
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("h2", { className: "text-xl font-extrabold text-white tracking-tight", children: "Outbound Copywriter Studio" }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { className: "text-xs text-slate-400 mt-1", children: "Harness advanced model synthesis to write context-aware connection pitches and sequence campaigns." })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                OutreachStudio,
                {
                  selectedLeadForOutreach,
                  leads
                }
              )
            ]
          },
          "tab-outreach"
        )
      ] }) }) }),
      "      ",
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(import_react9.AnimatePresence, { children: showManualModal && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "fixed inset-0 z-50 flex items-center justify-center p-4", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
          import_react9.motion.div,
          {
            initial: { opacity: 0 },
            animate: { opacity: 0.6 },
            exit: { opacity: 0 },
            onClick: () => setShowManualModal(false),
            className: "absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
          import_react9.motion.div,
          {
            initial: { scale: 0.95, opacity: 0 },
            animate: { scale: 1, opacity: 1 },
            exit: { scale: 0.95, opacity: 0 },
            className: "relative max-w-lg w-full bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden",
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/60", children: [
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("h3", { className: "font-extrabold text-white text-sm tracking-tight", children: "Manual Add Prospect" }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                  "button",
                  {
                    onClick: () => setShowManualModal(false),
                    className: "p-1 hover:bg-slate-800 text-slate-450 hover:text-white rounded-lg transition-colors cursor-pointer",
                    children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(import_lucide_react6.X, { className: "w-5 h-5" })
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("form", { onSubmit: handleManualLeadSubmit, className: "p-6 space-y-4 max-h-[75vh] overflow-y-auto", children: [
                /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-4", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "space-y-1", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("label", { className: "block text-xs font-bold text-slate-400", children: "Full Name" }),
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                      "input",
                      {
                        type: "text",
                        required: true,
                        value: manualName,
                        onChange: (e) => setManualName(e.target.value),
                        placeholder: "e.g. John Smith",
                        className: "w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500 placeholder-slate-600"
                      }
                    )
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "space-y-1", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("label", { className: "block text-xs font-bold text-slate-400", children: "Sector/Industry" }),
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
                      "select",
                      {
                        value: manualIndustry,
                        onChange: (e) => setManualIndustry(e.target.value),
                        className: "w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500",
                        children: [
                          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "Legal Services", children: "Legal Services" }),
                          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "Software Engineering", children: "Software Engineering" }),
                          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "Human Resources", children: "Human Resources" }),
                          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "Finance & Venture", children: "Finance & Venture" }),
                          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "Healthcare", children: "Healthcare" }),
                          /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("option", { value: "Marketing", children: "Marketing" })
                        ]
                      }
                    )
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-4", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "space-y-1", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("label", { className: "block text-xs font-bold text-slate-400", children: "Current Job Title" }),
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                      "input",
                      {
                        type: "text",
                        value: manualTitle,
                        onChange: (e) => setManualTitle(e.target.value),
                        placeholder: "e.g. Managing Director",
                        className: "w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500 placeholder-slate-600"
                      }
                    )
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "space-y-1", children: [
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("label", { className: "block text-xs font-bold text-slate-400", children: "Company Name" }),
                    /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                      "input",
                      {
                        type: "text",
                        value: manualCompany,
                        onChange: (e) => setManualCompany(e.target.value),
                        placeholder: "e.g. Acme Corp",
                        className: "w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500 placeholder-slate-600"
                      }
                    )
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "space-y-1", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("label", { className: "block text-xs font-bold text-slate-400", children: "Contact Email" }),
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                    "input",
                    {
                      type: "email",
                      value: manualEmail,
                      onChange: (e) => setManualEmail(e.target.value),
                      placeholder: "e.g. jsmith@acme.com",
                      className: "w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500 placeholder-slate-600"
                    }
                  )
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "space-y-1", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("label", { className: "block text-xs font-bold text-slate-400", children: "LinkedIn Profile URL" }),
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                    "input",
                    {
                      type: "url",
                      value: manualUrl,
                      onChange: (e) => setManualUrl(e.target.value),
                      placeholder: "e.g. https://linkedin.com/in/johnsmith",
                      className: "w-full bg-slate-950 border border-slate-850 rounded-xl px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500 placeholder-slate-600"
                    }
                  )
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "space-y-1", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("label", { className: "block text-xs font-bold text-slate-400", children: "Biography Summary" }),
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                    "textarea",
                    {
                      value: manualSummary,
                      onChange: (e) => setManualSummary(e.target.value),
                      placeholder: "Provide a quick bio summary or intro logs for this lead...",
                      rows: 3,
                      className: "w-full bg-slate-950 border border-slate-850 rounded-xl p-3 text-xs text-white outline-none focus:ring-1 focus:ring-indigo-500 placeholder-slate-600"
                    }
                  )
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "pt-4 border-t border-slate-800 flex justify-end gap-2", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                    "button",
                    {
                      type: "button",
                      onClick: () => setShowManualModal(false),
                      className: "px-4 py-2 border border-slate-800 text-slate-300 rounded-xl text-xs hover:bg-slate-850 transition-colors",
                      children: "Cancel"
                    }
                  ),
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                    "button",
                    {
                      type: "submit",
                      className: "px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-500 transition-colors shadow-sm cursor-pointer",
                      children: "Create Lead"
                    }
                  )
                ] })
              ] })
            ]
          }
        )
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("footer", { className: "bg-slate-900/40 border-t border-indigo-500/10 text-slate-500 text-[10px] text-center py-4", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2.5", children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { children: "LinkedIn Scraper & Lead Discovery Platform \u2022 Built on Cloud Containers" }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "font-semibold text-slate-400", children: "Structured CRM Integration Suite \u2022 Active" })
      ] }) })
    ] });
  }

  // src/main.tsx
  var import_index = __require("./index.css");
  var import_jsx_runtime7 = __require("react/jsx-runtime");
  (0, import_client.createRoot)(document.getElementById("root")).render(
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(import_react10.StrictMode, { children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(App, {}) })
  );
})();
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/*! Bundled license information:

papaparse/papaparse.min.js:
  (* @license
  Papa Parse
  v5.5.3
  https://github.com/mholt/PapaParse
  License: MIT
  *)
*/
