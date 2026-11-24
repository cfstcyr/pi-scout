# Changelog

## [0.2.0] - 2026-11-23

- Push without the tool is the default: the researcher's dated map is injected once per prompt when it finishes (else at
  settle); no `scout` tool, guideline or reminder. Opt-in `"delivery": "pull"` / `"tool": true`.
- Regression fix : judge prompt back to v7b (no `[external]` marker or sentence);
  the map's external cap and head rule apply to open-world items only.


## [0.1.0] - 2026-11-23

- First package of the scout v7b pull configuration (background researcher + `scout` tool + guideline + settle
  reminder) for daily use. 
