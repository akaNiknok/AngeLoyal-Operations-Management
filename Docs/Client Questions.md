# Client Questions — AngeLoyal

Open questions for the client. The answers set rules for the rest of migration Phase 3 (the RTVS tab and payroll, see [`D1 Migration.md`](D1%20Migration.md)) and correct some billing rules that are live today.

- **★** marks a question that blocks v2.0.0 work, or a rule we may bill wrong today.
- Each question says what the system does now, so the client can say "correct" or give the right rule.
- When an answer comes in, write it under the question, change the code and `Docs/Schema.md`, then strike the question out.

Sources: the two interview notes in this folder, `Sample Files/Billing/`, and the billing code as of 2026-09-30.

## A. Drop fee ("Additional 500 per 3 drops")

1. **★** How does the fee grow past 3 drops? Today the system bills one flat ₱560 at 3 or more drops. The options:
   - One fee for any load with 3 or more drops (what the system does today).
   - One fee for each full 3 drops, so 6 drops = 2 fees.
   - One fee for each drop from the 3rd drop on.
2. **★** What is a drop: a store or a freight order (FO)? Today, two FOs to the same store count as 2 drops.
3. Does a `-R` (redeliver) or `-FT` (foul trip) load count its own drops, or do they add to the drops of the original load?
4. The printed header says 500, but the system bills 560 (500 + 12% VAT). Is the VAT-inclusive amount correct?

## B. Dates

5. **★** Which date puts a load into a weekly billing? The code uses the **delivery date**. `Docs/Schema.md` says the **original order date**. Example: a load is ordered Saturday, carried over, and delivered Monday. Which week bills it?
6. Which diesel price applies to a carried-over load? Today: the price of the original day, not the delivery day.
7. For a carry-over, which date prints in the DATE column? Today: the delivery date.
8. Confirm the DOE week: prices are posted Monday and are in force from Tuesday to the next Monday. Interview 1 was not clear on this (the May 4 / May 5 remark).
9. When a new rate matrix arrives mid-week, does it re-price loads that are delivered but not yet billed? Today it does not: the rate that applies is the one in force on the billing date.
10. Is the billing week Monday to Saturday? How do they bill Sunday trips?
11. Carry-over skips Sundays only. Must it also skip Philippine holidays? The same holiday list will drive POD aging and payroll.

## C. DOE rate matrix

12. **★** The matrix uses the same name for different towns: "Rosario" ×3 and "San Juan" ×2 (for 6W, ₱6,760 vs ₱16,490). No province column tells them apart, so today the first row wins. Can they add a province to the matrix? Does the Rebisco route file give a province for each area?
13. Some route-file areas do not match any matrix spelling. The Billing tab flags these lines. Can they give us an alias list?
14. Are the matrix rates VAT-inclusive? The billing footer assumes every total includes VAT.

## D. Mano

15. **★** Today the system bills ₱392 (350 + VAT) for each full 100 cartons at one store. In interview 1 they said "₱200" and also "a fixed amount per box". Please confirm:
    - the amount
    - per store or per load
    - whether 250 cartons = 2 fees

## E. Foul trips, redeliveries, split loads

16. **★** `Foul Trip - No Redeliver` bills nothing today, but `Docs/Schema.md` says it bills as a foul trip. Does it bill? If yes, at the full rate, a percentage, or a flat fee?
17. **★** They described three cases of incomplete delivery: not billable (our fault), billable for day 1 only, and billable for both days. Map each case to the system statuses (`Foul Trip - No Redeliver`, `Foul Trip - For Redeliver`, `Redeliver`, `Two-Day Trip`).
18. For a Two-Day Trip (one billing), which day's price and date apply?
19. Rebisco orders a 4W and the warehouse loads a 6W. Today the assigned truck's type sets the rate, and the dispatcher can type over the rate. Is that enough, or must the bill wait until Rebisco approves?
20. "A 4W with no helper → charge for an extra helper." What is the amount? Does it go in its own column?
21. When an FO splits into A/B/C, does each part get its own drop fee and Mano?

## F. RTVS billing (★ all — we build this now)

22. The RTVS BILLING tab in both sample workbooks is empty. We need a filled example.
23. That tab has a **ROUTE #** column where the trips tab has FREIGHT ORDER #. What is a Route #?
24. Is ₱5.00 per box VAT-inclusive? Does the tab hold only bad orders, or also backloads ("half a truck of unsold goods")? How is a backload priced?
25. Where does the box count come from (an RTV slip?), and which waybill or trip does the return link to?
26. Does RTVS get its own billing number, or does it share one with the trips billing for the same week?
27. The trips billing already has a "Bad Orders @5.00/Bx" column. Does it move to the RTVS tab, or stay in both?

## G. Other billing

28. AY and GL are different companies. Does each one submit its own billing with its own letterhead and approver? Today every printout carries the AngeLoyal letterhead and Angelo Medina's name.
29. Do VAT and the 2% withholding apply to reimbursements (parking, RORO, the Revolutionary Tax)? Today the footer taxes every peso the same way.

## H. Payroll (★ all — we build this now)

30. Send the driver-rates workbook ("around 12 rates by truck type"). They promised it in interview 2. The repo does not have it.
31. Is pay per day or per trip? What counts as a double trip: two waybills in one day, or a `-R`?
32. Are helpers in this payroll? What are their rates? When a load has no helper, does the driver get the full helper rate?
33. Night differential: which hours, which rate, and where does the time come from? Can their time-in/time-out app export a CSV? What is the app?
34. Who records absences: the timesheet app or the dispatcher?
35. The cut-off is Wednesday. Is the pay week Thursday to Wednesday, and which day is payday?
36. SSS, PhilHealth and Pag-IBIG: interview 1 wanted the system to compute them, and interview 2 said "manual for now". Which one? If the system computes them, how does it split a monthly contribution across the weeks?
37. Does the 13th month use basic pay only (₱695/day) or also the allowances? The law says basic pay only.
38. "No POD, no pay": does it hold the whole payslip or only those trips? POD tracking comes later. Can v2.0.0 ship without the hold?
39. Which deductions go on the payslip: POD penalties (₱500 / ₱1,000), cash advances (vale), loans, damages?
40. Can they send a sample payslip?
41. Assigned a 6W but drove a 4W: which rate does the driver get?
42. Are GL drivers in our payroll?
