# Documentation Style

Use this profile for Pi Bebop documentation.

## Goal

Write clear instructions for people and agents. State facts. State limits. Do not make claims that the product cannot prove.

## STE100 profile

Use these rules when you add or change prose:

1. Use short sentences. Keep instructions to 20 words or fewer. Keep descriptions to 25 words or fewer.
2. Use active voice. Name the actor that performs an action.
3. Give one action in each numbered step.
4. Start instructions with a verb. Use `Do not` for a prohibition.
5. Use one term for one concept. Use the terms in [UL.md](../UL.md).
6. Prefer common, concrete words. Avoid vague words such as `simply`, `obviously`, `easy`, and `etc.`.
7. State a limit with a number, unit, and condition.
8. State an outcome without claiming completion, approval, availability, or security unless Bebop proves it.
9. Define an abbreviation at its first use. Keep code identifiers, commands, protocol values, and fixed error text unchanged.
10. Use `must` for a mandatory rule. Use `can` for a possible result. Do not use `should` for a requirement.

## Document pattern

Use this order when it fits the document:

1. **Purpose** — state what the feature or guide covers.
2. **Use** — give the shortest safe command or tool example.
3. **Result** — state what success means and does not mean.
4. **Limits** — state important boundaries and failure cases.
5. **Reference** — give exact schemas, values, or lifecycle rules.

Put the common case before the full contract. Keep reference material exact. Do not rewrite protocol literals or JSON only to meet a prose rule.

## Markdown

- Use one H1 heading.
- Use sentence-case headings.
- Use fenced blocks for commands, JSON, and output.
- Use tables only for comparisons or closed value sets.
- Link related documents with a relative path.
- Keep lines near 100 characters where practical.

## Scope

This profile applies to `README.md`, `UL.md`, `docs/`, and the crew instruction templates.
It does not change historical plans, task records, generated files, source comments, or third-party files.
