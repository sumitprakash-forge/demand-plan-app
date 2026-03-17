# Map raw Databricks SKU names to friendly names
SKU_FRIENDLY_NAMES = {
    "PREMIUM_ALL_PURPOSE_COMPUTE": "All Purpose Compute",
    "PREMIUM_ALL_PURPOSE_COMPUTE_(PHOTON)": "All Purpose Compute (Photon)",
    "PREMIUM_JOBS_COMPUTE": "Jobs Compute",
    "PREMIUM_JOBS_COMPUTE_(PHOTON)": "Jobs Compute (Photon)",
    "PREMIUM_JOBS_SERVERLESS_COMPUTE": "Serverless Jobs",
    "PREMIUM_SQL_COMPUTE": "SQL Warehouse",
    "PREMIUM_SQL_SERVERLESS_COMPUTE": "Serverless SQL",
    "PREMIUM_DLT_CORE_COMPUTE": "DLT Core",
    "PREMIUM_DLT_CORE_COMPUTE_(PHOTON)": "DLT Core (Photon)",
    "PREMIUM_DLT_ADVANCED_COMPUTE": "DLT Advanced",
    "PREMIUM_DLT_ADVANCED_COMPUTE_(PHOTON)": "DLT Advanced (Photon)",
    "PREMIUM_DLT_PRO_COMPUTE": "DLT Pro",
    "PREMIUM_MODEL_SERVING": "Model Serving",
    "PREMIUM_SERVERLESS_REAL_TIME_INFERENCE": "Serverless Inference",
    "PREMIUM_FOUNDATION_MODEL_TOKENS": "Foundation Model API",
    "PREMIUM_VECTOR_SEARCH": "Vector Search",
}


def get_friendly_name(raw_sku: str) -> str:
    # Try exact match first
    if raw_sku in SKU_FRIENDLY_NAMES:
        return SKU_FRIENDLY_NAMES[raw_sku]
    # Try prefix match (for region-specific SKUs like PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST)
    for prefix, friendly in SKU_FRIENDLY_NAMES.items():
        if raw_sku.startswith(prefix):
            return friendly
    # Fallback: clean up the raw name
    return raw_sku.replace("PREMIUM_", "").replace("_", " ").title()
