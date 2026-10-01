# Task 4 preflight — approved M0 V3 Native plan

Base RBridge ca566d1969a7ced874a09307b644cf7e88c1a1e3 / tree5c99c0da1194fe382695276d80e130ddb361326c; existing V1 worker/downlink and SEND guards remain qualified. Implement only the mapped ledger/dispatcher plus targeted negotiated-peer ingress denial and test runner registration. Do not advertise V3 or install runtime.

Storage authority is the existing ChromeStorageAreaV1 under one owning service-worker process. Ledger writes and mutation arrival queues are shared by stores using the same storage adapter. Any uncertainty, quota, corruption or disappearing observed ledger fails closed. Original complete commands and requests, pending effect observations, and completed results are retained; a fixed bounded total ledger refuses growth without evicting identities.

Reserve mutation arrival before asynchronous crypto/storage. Durable pre-click UNCERTAIN is an effect observation, never a completed command result. Exact command replay returns original completed bytes. Different EXECUTE command IDs for the same effect only observe the original effect and never call executor. RECONCILE reserves only its independent command identity, creates no effect, does not wait for the mutation queue, and does not change effect observations. Restart with pending intent returns UNCERTAIN without retrying; unresolved earlier effects block later mutations.

Deny V1 mutations before the legacy dispatch hook when the same native connection has negotiated V3 effect authority. Preserve V1 READ_STATE/DISCOVER_TARGET and historical event validation. Runtime HELLO remains minor0 until the transport/qualification tasks.

RED first: named restart/new-ID, delayed crypto arrival order and reconciliation while mutation hangs, plus altered bytes, collision, snapshots, quota/write/readback/corruption failures and V1 bind/leader/capture denial. GREEN then actual R APP UID/GID1027, canonical verify, post-build lint, exact Linux+Windows CI and independent review. SOURCE qualification remains distinct from browser acceptance.
