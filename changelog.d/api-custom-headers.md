### Added

- **API catalogs can send custom headers.** A catalog's top level and each request take an
  optional `"headers": {"<Name>": "<value>"}` (a request's entries replace the catalog's,
  names compared case-insensitively), so an API that expects a request ID, a tenant, a client
  name or a vendor media type can be cataloged without a workaround. A value is literal text
  with `{param}` refs (header-only, never added to the URL; `--omit` drops the header) and
  `${ENV_VAR}` refs, whose resolved value is redacted like a credential. Any valid header name
  is allowed, `Content-Type` and `Accept` included; `Authorization`, `Proxy-Authorization` and
  `Cookie` stay with `auth`, the header an `apiKey` auth already sends cannot be set twice,
  and `Host`, `Content-Length`, `Transfer-Encoding` and `Connection` are left to the HTTP
  client. Those, an invalid name, a non-string value, an undeclared `{param}` and a value with
  a line break or control character are BLOCKED (`reasonCode: "bad-headers"`) before anything
  is sent, without echoing the value. The custom headers sent are listed under the request line
  of the evidence log. A catalog without `headers` sends and logs exactly what it did before.
  swagger-import still skips `in: header` params; its mapping notes how to add one by hand.
  Covered by 20 new cases in `run_api.test.js`.
