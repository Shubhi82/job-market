from datetime import datetime, timezone


def utc_now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_company_portals(config):
    target_roles = config.get("profile", {}).get("target_roles", [])
    target_role_text = ", ".join(target_roles[:6])
    default_keywords = config.get(
        "company_portal_search_keywords",
        [
            "data governance",
            "master data",
            "data quality",
            "privacy",
            "risk",
            "analytics engineer",
        ],
    )
    default_locations = config.get("company_portal_locations", ["Remote", "Delhi NCR", "Gurugram", "Noida", "Bengaluru", "Hyderabad"])

    portals = []
    for portal in config.get("company_portals", []):
        portals.append(
            {
                "company": portal["company"],
                "portal_url": portal["portal_url"],
                "search_url": portal.get("search_url") or portal["portal_url"],
                "career_area": portal.get("career_area", ""),
                "source_type": portal.get("source_type", "company_portal_watchlist"),
                "notes": portal.get("notes", ""),
                "suggested_keywords": portal.get("suggested_keywords") or default_keywords,
                "suggested_locations": portal.get("suggested_locations") or default_locations,
                "target_role_text": portal.get("target_role_text") or target_role_text,
                "updated_at": utc_now_iso(),
            }
        )

    return portals
