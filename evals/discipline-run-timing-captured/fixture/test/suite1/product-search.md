# Product search suite

env: qc

1. **search-common-term** — search "shirt"; expect a non-empty result grid.
2. **search-nonsense-term** — search "zzzxqq"; expect a "no results" message.
3. **search-filter-combo** — combine category + price filters (DE-SCOPED for this run by
   the user: the filter service is being replaced this sprint).
