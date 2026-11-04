"""Prompt text for a ModelRequest's prompt_template_id plus its PROMPT_ARGS (ADR 0014)."""


def prompt_for(template_id: str, args: dict) -> str:
    # Lazy: probe imports meta_client, which imports backend, which imports this module.
    from memripal.associate import association_prompt
    from memripal.probe import PHRASE_PROMPT, _reask_prompt
    from memripal.split import split_prompt

    if template_id == "association":
        return association_prompt(
            args["item"], args["locus"], args.get("reason"), args.get("place"), args.get("station")
        )
    if template_id == "phrase":
        return PHRASE_PROMPT
    if template_id == "phrase-reask":
        return _reask_prompt(list(args["exclude"]))
    if template_id == "split":
        return split_prompt(args["notes"], args["max_points"])
    if template_id == "scene":
        from memripal.scenes import scene_prompt

        return scene_prompt(args["record"])
    if template_id == "station":
        from memripal.station import station_prompt

        # Absent == no used names, matching parse_used_names' absent-header rule.
        return station_prompt(args.get("used_names", []))
    raise ValueError(f"unknown prompt template: {template_id!r}")
