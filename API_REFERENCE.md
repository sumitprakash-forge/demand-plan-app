# Demand Plan App - API Reference

## Base URL
```
http://localhost:8000
```

## Endpoints

### Summary Data
```http
GET /api/summary-all?account={account}
```
**Response:**
```json
{
  "account": "Kroger",
  "scenarios": [
    {
      "scenario": 1,
      "summary_rows": [
        {"use_case_area": "Baseline", "year1": ..., "year2": ..., "year3": ..., "total": ...},
        {"use_case_area": "New Use Cases", ...},
        {"use_case_area": "Grand Total", ...}
      ],
      "domain_breakdown": [{"domain": "...", "value": ...}]
    }
  ]
}
```

---

### Consumption Data (Historical)
```http
GET /api/consumption?account={account}&refresh={false}
```
**Response:**
```json
{
  "data": [
    {
      "workspace_name": "workspace-1",
      "cloud": "azure",
      "month": "2025-03",
      "sku": "PREMIUM_ALL_PURPOSE_COMPUTE",
      "total_dbus": 7506.18,
      "dollar_dbu_list": 4128.40
    }
  ],
  "source": "cached"
}
```

**Query Parameters:**
- `account`: Account name or SFDC ID (string, required)
- `refresh`: Force Logfood query instead of cache (boolean, default=false)

---

### SKU Prices
```http
GET /api/sku-prices?account={account}
```
**Response:**
```json
{
  "sku_prices": [
    {
      "raw_sku": "PREMIUM_ALL_PURPOSE_COMPUTE",
      "friendly_name": "All Purpose Compute",
      "cloud": "azure",
      "list_price": 0.55
    }
  ],
  "clouds": ["aws", "azure", "gcp"],
  "friendly_skus": [
    {
      "friendly_name": "All Purpose Compute",
      "clouds": {"azure": 0.55, "gcp": 0.45}
    }
  ]
}
```

---

### Scenario Configuration
```http
GET /api/scenario?account={account}&scenario={scenario_num}
```
**Response:**
```json
{
  "scenario_id": 1,
  "account": "Walmart",
  "baseline_growth_rate": 0.05,
  "assumptions_text": "test",
  "new_use_cases": [
    {
      "id": "ae1bgc3",
      "name": "Informatica Migration",
      "steadyStateDbu": 35000,
      "onboardingMonth": 3,
      "liveMonth": 8,
      "rampType": "hockey_stick",
      "scenarios": [true, false, false],
      "cloud": "aws",
      "skuBreakdown": [
        {
          "sku": "Premium Jobs Compute",
          "percentage": 50,
          "dbus": 17500,
          "dollarDbu": 5250
        }
      ]
    }
  ]
}
```

---

### Save Scenario
```http
POST /api/scenario
Content-Type: application/json
```
**Request Body:**
```json
{
  "account": "Walmart",
  "scenario_id": 1,
  "baseline_growth_rate": 0.05,
  "assumptions_text": "Growth assumptions",
  "new_use_cases": [
    {
      "id": "use-case-1",
      "name": "New Migration",
      "steadyStateDbu": 35000,
      "onboardingMonth": 3,
      "liveMonth": 8,
      "rampType": "linear",
      "scenarios": [true, false, false],
      "cloud": "azure",
      "skuBreakdown": []
    }
  ]
}
```

**Response:**
```json
{
  "status": "ok",
  "key": "Walmart_1"
}
```

---

### Forecast Data
```http
GET /api/forecast?account={account}
```
**Response:**
```json
{
  "data": [
    {
      "workspace": "workspace-1",
      "domain": "Data & Business Insights",
      "cloud": "AWS",
      "monthly_dbu": 125000.50,
      "total_dbu": 1500000.00
    }
  ]
}
```

---

### Account Overview
```http
GET /api/account-overview?account={account}
```
**Response:**
```json
{
  "account": "Kroger",
  "total_t12m": 12439976,
  "total_t3m": 2565543,
  "growth_rate": -15.1,
  "workspace_count": 324,
  "domain_count": 1,
  "monthly_trend": [
    {"month": "2024-03", "value": 956152},
    {"month": "2024-04", "value": 987321}
  ],
  "top_domains": [
    {"domain": "Data & Business Insights", "value": 3548489}
  ],
  "domain_table": [
    {"domain": "...", "total_dbu": ..., "pct": ...}
  ]
}
```

---

### Upload Consumption CSV
```http
POST /api/consumption/upload?account={account}
Content-Type: multipart/form-data
```
**Parameters:**
- `account`: Account name (string, required)
- `file`: CSV file with consumption data (file, required)

**CSV Format:**
```
workspace_name,cloud,month,sku,total_dbus,dollar_dbu_list
workspace-1,azure,2025-03,PREMIUM_ALL_PURPOSE_COMPUTE,7506.18,4128.40
```

**Response:**
```json
{
  "data": [...],
  "count": 100
}
```

---

### Domain Mapping
```http
GET /api/domain-mapping?sheet_url={google_sheets_url}
```
**Response:**
```json
{
  "mapping": [
    {
      "workspace": "workspace-1",
      "domain": "Data & Business Insights",
      "cloudtype": "azure",
      "org": "EMEA"
    }
  ]
}
```

---

## Data Models

### AccountConfig
```typescript
{
  name: string;        // Display name (e.g., "Kroger")
  sfdc_id: string;     // SFDC Account ID or account name for Logfood
  sheetUrl: string;    // Optional Google Sheets URL for domain mapping
}
```

### NewUseCase
```typescript
{
  id: string;                    // Unique identifier
  name: string;                  // Display name
  domain: string;                // Domain/team
  steadyStateDbu: number;        // Target monthly DBU
  onboardingMonth: number;       // Month 1-36
  liveMonth: number;             // Month 1-36 (>= onboarding)
  rampType: "linear" | "hockey_stick";
  scenarios: boolean[];          // [scenario1, scenario2, scenario3]
  cloud: "aws" | "azure" | "gcp";
  assumptions: string;           // Free text notes
  skuBreakdown: {                // Optional detailed SKU allocation
    sku: string;
    percentage: number;          // 0-100
    dbus: number;                // Calculated monthly DBU
    dollarDbu: number;           // Calculated monthly cost
  }[];
}
```

---

## Caching Strategy

### Two-Tier Cache
1. **In-Memory Cache** - Fastest, lost on restart
2. **JSON File Cache** - Persistent in `/server/data/`

### Cache Files
- `consumption_{account}.json` - 10k+ records, auto-persisted
- `sku_prices_{account}.json` - 28-42 SKU entries
- `scenario_{account}_{scenario}.json` - Scenario configuration
- `domain_mapping.json` - Domain mappings

### Cache Behavior
- GET requests use cache by default
- Use `?refresh=true` to force Logfood query
- Cache survives server restart
- Logfood query used if cache missing

---

## Error Responses

### 404 Not Found
```json
{"detail": "Not Found"}
```

### 500 Server Error
```json
{
  "detail": "Logfood query failed: [error message]. Use CSV upload as fallback."
}
```

---

## T-Shirt Sizes
| Size | DBU/month | Description |
|------|-----------|-------------|
| XS | 2,500 | POC / Experiment |
| S | 5,000 | Single pipeline or dashboard |
| M | 15,000 | Team workload — ETL + BI |
| L | 35,000 | Multi-pipeline ETL + ML |
| XL | 75,000 | Department — heavy ETL + ML + BI |
| XXL | 150,000 | Business unit — full platform |
| XXXL | 300,000 | Enterprise — org-wide workload |

---

## Workload Presets
| Preset | SKU Mix |
|--------|---------|
| ETL Pipeline | 50% Jobs, 30% Photon, 20% DLT |
| BI/Analytics | 60% Serverless SQL, 25% All Purpose, 15% Jobs |
| ML Platform | 35% All Purpose, 30% Model Serving, 25% Jobs, 10% SQL |
| Agentic AI | 40% Foundation Model, 25% Serving, 20% Vector, 15% SQL |
| Migration | 45% Photon, 30% Serverless SQL, 25% DLT |

---

## Performance Tips

1. **First Load:** API queries Logfood, saves to JSON cache
2. **Subsequent Loads:** Use JSON cache (sub-second response)
3. **Multiple Accounts:** Each account cached independently
4. **Export:** Combines cached data in-memory before generating Excel

---

## Testing

All endpoints tested and verified working:
- Kroger: T12M $12.4M, 10,161 records
- 84.51: T12M $12.6M, 4,650 records
- Walmart: T12M $28.9M, 9,770 records

No errors, full data consistency verified.

