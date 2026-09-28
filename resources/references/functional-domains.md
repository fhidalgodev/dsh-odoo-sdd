# Functional domains — what to ask, what it depends on, what to verify, what can go wrong

One checklist per domain, for a **functional** run (see
`../SKILL.md`). They are prompts to investigate, in the order the work usually
happens: configuration first, master data second, transactions third.

Three rules that apply to every entry:

- **Capability is verified, not assumed.** "Odoo has it" is not "this instance
  has it": confirm the version, the edition and the installed modules before
  relying on a feature, and confirm the field names on the actual model.
- **Fiscal and legal data is never derived here.** Country, regime, taxes,
  accounts and valuation come from a named human. Nothing in this file defines an
  obligation.
- **The checklist is a starting point, not a payload.** The same domain in two
  companies rarely needs the same operations; the batches are built from the
  interview, not from this list.

## Company, branches and multi-company

- **Ask:** which legal entities exist, which one owns which operations, whether
  they share a chart of accounts, whether inter-company transactions happen, and
  which company the run is allowed to touch.
- **Depends on:** user access to each company, the installed localisation,
  currency configuration, fiscal positions.
- **Verify:** the active company of every read and write (`allowed_company_ids` /
  `company_id`), that records landed in the intended company, and that nothing
  was duplicated across companies by a default.
- **Risks:** a batch applied in the wrong company; shared master data silently
  changed for everyone; inter-company rules firing without being reviewed.

## Users, groups and access

- **Ask:** who does what, which existing groups already cover it, whether new
  groups are acceptable, and whether the run may change access at all.
- **Depends on:** the module providing the security model, the company set, the
  access rules the flows need.
- **Verify:** the group memberships actually applied, that a user of the target
  group can perform the flow and one outside it cannot.
- **Risks:** granting more than intended (`base.group_system` is not a shortcut);
  breaking an existing user's access; a rule that applies globally because it has
  no group.

## Contacts (partners)

- **Ask:** which partners are customers, suppliers or both, whether the source
  data has duplicates, who owns the company/parent relationship, and how
  addresses and VAT are to be identified.
- **Depends on:** the country configuration, res.partner fields actually in use,
  whether the VAT is validated per country, existing duplicates.
- **Verify:** the count created, spot checks on VAT/address/parent, and that
  re-running the same file does not duplicate.
- **Risks:** duplicates created by importing instead of matching; VAT unique
  constraints failing halfway; the parent/child relations flattened.

## Catalogue: products, categories, UoM, variants, prices

- **Ask:** which units of measure are really used, whether variants are needed,
  how prices are derived (sales price, pricelists, margins), and who maintains
  categories.
- **Depends on:** the UoM categories present, the pricelist model in use,
  product types (goods/services), purchase and sale taxes.
- **Verify:** UoM conversions on a sample, that a variant generates the expected
  attributes, and the price seen by a customer in the intended pricelist.
- **Risks:** products created without a UoM category that matches operations;
  prices overwritten globally instead of per pricelist; taxes defaulting from a
  parent category nobody reviewed.

## Accounting, localisation and taxes

- **Ask:** who confirms the localisation, whether the chart is already installed,
  which fiscal positions apply, and what the closing/Tax-reporting expectations
  are. **This domain is never decided by the agent.**
- **Depends on:** the installed localisation module, existing journal entries,
  the fiscal year, lock dates, the accountant's availability.
- **Verify:** taxes appearing on a sample invoice/entry, the accounts posted to,
  and that nothing was posted into a closed period.
- **Risks:** installing a chart template that replaces configuration or affects
  related companies; opening a period that was closed; tax changes that silently
  alter historical reports.

## Sales, CRM and purchases

- **Ask:** which documents the flows produce, the numbering expectations, the
  approval steps, and whether old documents must be migrated.
- **Depends on:** pricelists, taxes, warehouses and routes, payment terms,
  whether the documents are still open.
- **Verify:** one full flow end to end in staging (quotation → order → delivery →
  invoice) before touching volume.
- **Risks:** migrating historical documents with the wrong dates or states;
  triggering confirmations that create stock or journal entries.

## Inventory: warehouses, routes, replenishment, traceability

- **Ask:** how many warehouses and locations, the replenishment strategy, whether
  lot/serial tracking is required, and how initial stock will be counted.
- **Depends on:** product types, UoM, routes and rules, existing stock moves,
  valuation method (**confirmed by a human**).
- **Verify:** an opening adjustment on a sample, the resulting valuation, and the
  route taken by a test order.
- **Risks:** opening stock that breaks the valuation; routes created ad hoc;
  traceability enabled after goods already moved.

## POS

- **Ask:** how many shops, sessions and payment methods, which journals and
  accounts they post to, and who closes the sessions.
- **Depends on:** products and taxes, the chart, the payment providers, the
  hardware/browser setup.
- **Verify:** one configured shop in staging: open a session, sell, close it, and
  check the journal entry and the stock move.
- **Risks:** configuration that posts to the wrong journal; sessions left open;
  products configured for POS but not available in the intended shop.

## Manufacturing

- **Ask:** which products are manufactured, the bills of materials, the work
  centres and routings, and whether subcontracting is in scope.
- **Depends on:** UoM, routes, work centres, lead times, valuation.
- **Verify:** one manufacturing order for a sample product, including component
  consumption and the resulting valuation.
- **Risks:** BoMs that consume more than expected; lead times that silently
  change planning; by-products and scrap unaccounted for.

## Projects and services

- **Ask:** whether time is tracked, how it is invoiced (fixed, hourly, milestones)
  and who approves it.
- **Depends on:** the invoicing policy, analytic accounts, employee records,
  service products.
- **Verify:** a project with a task, a timesheet and its invoice in staging.
- **Risks:** service products without the right invoicing policy; analytic
  distributions that put costs in the wrong account.

## Human resources

- **Ask:** which records are needed (employees, departments, contracts), whether
  payroll or attendance is in scope, and **who owns the personal data**.
- **Depends on:** the installed HR modules, the company, the legal review for
  personal data.
- **Verify:** a sample employee with the intended department and contract, and
  that access to those records is limited to the right groups.
- **Risks:** personal data loaded with broader access than intended; contract or
  payroll data imported without the responsible party's confirmation.

## Anything the interview discovered that is not listed here

Investigate it the same way: **ask** who owns the decision, **confirm** the
capability in the installed version, **verify** the result in staging, and write
down the **risk** and the recovery before proposing a batch. If the need requires
code, record the gap in the spec and propose a separate technical spec instead of
installing something improvised.
