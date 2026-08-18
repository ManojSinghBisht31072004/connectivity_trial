# Tally Bridge Agent — Setup (Windows .exe)

1. Open TallyPrime, load your company, then enable the connector:
   F1 (Help) -> Settings -> Connectivity -> set the TCP/IP port to 9000
   (or your chosen port) and enable the ODBC/HTTP server.
2. Rename "config.example.json" to "config.json" (same folder as the .exe)
   and fill in:
     "cloudApiUrl": the URL your provider gave you
     "apiKey": the key your provider gave you
   (leave tallyHost/tallyPort as-is unless told otherwise)
3. Double-click TallyBridgeAgent.exe. A console window opens and stays
   open — leave it running. It checks for new invoices every few seconds
   and pushes them into Tally automatically.
   (Windows may show a SmartScreen warning since this isn't code-signed —
   click "More info" -> "Run anyway".)
4. To stop it, just close the console window.

No Node.js install needed — everything is bundled inside the .exe.
