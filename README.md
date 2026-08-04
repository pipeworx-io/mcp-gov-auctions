# mcp-gov-auctions

Government Auctions MCP — physical-asset auctions (surplus, seized, forfeited,

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `auctions_search` | Search live US government auction lots for physical assets sold to the public — surplus vehicles, heavy equipment, real estate, electronics — from state/local governments (GovDeals, AllSurplus) and IRS seized/forfeited property. Filter by free-text keyword (matched on the item title, e.g. "truck", "excavator", "pickup"), 2-letter state, asset_type (vehicle\|equipment\|realestate\|electronics\|other), max_price (current bid ceiling), and closing_within_hours. Returns each lot with source, title, location, current bid, close time, and a link. For historical sold prices use auctions_sold_comps instead. |
| `auctions_closing_soon` | Live government auction lots ordered by soonest close time — the "what can I still bid on before it ends" view across all sources (GovDeals, AllSurplus, IRS). Optionally filter by state, asset_type, or keyword. Returns lots with time remaining, current bid, location, and link. |
| `auction_lot_details` | Full details for a single government auction lot, looked up by its source + source_lot_id (as returned by auctions_search) or by its listing URL. Returns title, description, category, location, bid, close time, seller agency, and link. |
| `auctions_sold_comps` | Historical SOLD prices for government auction items — the final hammer price of closed lots, which no upstream site keeps but Pipeworx retains. Use to answer "what do seized pickup trucks actually sell for" or to comp an asset. Filter by keyword (title match), asset_type, and/or state. Returns count, min/median/max/average final price, and recent examples. Only includes lots that have closed with a recorded final price. |
| `auctions_coverage` | What government-auction data Pipeworx currently holds: per-source active lot counts and data freshness (when each source was last refreshed). Use to gauge coverage and how current the data is before relying on it. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gov-auctions": {
      "url": "https://gateway.pipeworx.io/gov-auctions/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Gov Auctions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
