
# ANGELOYAL LOGISTICS
## Operations Management System
# PROJECT PROPOSAL
*Scope, Timeline & Agreement*

| | |
| :--- | :--- |
| **Prepared For:** | AngeLoyal Logistics |
| **Date:** | May 14, 2026 |
| **Prepared By:** | Independent Development Team |
| **Total Budget:** | **PHP 260,000.00** |
| **Version:** | 3 |

*This document is intended only for AngeLoyal management.*

***

## 1. What This Project Is About

AngeLoyal currently runs its day-to-day logistics operations — dispatch scheduling, billing, proof of delivery, and driver payroll — almost entirely through manual Excel files and messaging apps. This works, but as the business grows, it's becoming harder to keep track of everything without things slipping through the cracks.

This project proposes building a simple, web-based system to replace those manual processes, one step at a time. The objective is not to introduce complexity, but to make the team's daily operations faster, more organized, and less prone to errors.

### A Foundation for Scalability

By centralizing operations into a structured, digital system, AngeLoyal gains the ability to grow without a proportional increase in administrative overhead. Adding a new truck or onboarding a new client becomes a matter of updating records in one place, not reconfiguring a stack of spreadsheets. Billing and payroll that currently require hours of manual computation will run automatically regardless of whether there are 10 trips that week or 100.

The system is also being built with future migration in mind. Should AngeLoyal eventually outgrow the current setup and require a more powerful infrastructure — such as a dedicated server or SaaS platform — the clean, structured data and documented workflows built during this project provide a solid foundation to build on, rather than starting from scratch.

### How We’re Building It — The Agile Approach

This project follows an *Agile development approach*. Rather than delivering everything at the end, the project is broken into short development cycles. Instead, the team will work in short, focused periods called *sprints* — each lasting two weeks. At the end of every sprint, AngeLoyal gets to see what was built, try it out, and give feedback before the team moves on to the next sprint.

This approach has a few key benefits for AngeLoyal:
* AngeLoyal see progress every two weeks, not just at the end of four months.
* If something needs to be adjusted, it is corrected early — before it affects everything downstream.
* Features can be re-prioritized between sprint cycles based on what matters most to AngeLoyal.

The full system is organized into three phases, containing 3 sprints. Each phase focuses on a specific part of the operations and ends with a formal demo and sign-off before the next cycle begins.

| Phase | What Gets Built | When |
| :--- | :--- | :--- |
| **Phase 1** | Digital records for drivers, trucks, and trips. Daily dispatch scheduling and waybill tracking. | Months 1 – 2 |
| **Phase 2** | Auto-computed billing using the DOE rates matrix. Driver payroll computation. | Months 2 – 3 |
| **Phase 3** | Digital proof of delivery tracking, deadline alerts, and management reports. | Months 3 – 4 |
| **Total** | Full operations system — from dispatch to billing to payroll | **~4 months** |

*The timeline is based on approximately 14 hours of combined development and testing work per week across both team members. Milestones may shift slightly, but both parties will be informed in advance of any changes.*

***

## 2. What We're Solving

Based on an initial interview with AngeLoyal Logistics, here are the main pain points the system will address:

### Dispatch & Driver Scheduling
* Every day, the team manually downloads an Excel file from Rebisco, reformats it, and assigns drivers and trucks by copy-pasting. This takes time and occasionally results in the same driver being accidentally assigned twice.
* When a client calls in a last-minute trip, it gets inserted manually with no automatic record of when or by whom it was added.
* There's no easy way to see which drivers have been going to the same outlet repeatedly — which matters for managing driver familiarity and avoiding disputes.

### Waybill Tracking
* Waybill numbers are typed manually, which sometimes leads to duplicates.
* Waybill records are scattered across multiple Excel files with no central reference.

### Proof of Delivery (POD)
* Drivers return physical delivery receipts weekly, but the 3-day deadline for submitting them (per Rebisco's warehouse policy) is only tracked via group chats. Missing a deadline results in a penalty charge.
* There's no automatic alert when a POD is about to expire — staff have to manually check and follow up.
* Missing or incomplete receipts cause billing to be rejected and reprocessed, which delays payments.

### Billing
* Freight rates change weekly (based on DOE fuel prices) and vary by area and truck type. Computing the correct billing amount currently involves manually cross-referencing rates
* When rates are updated, there's a risk that old trips get re-priced incorrectly. There's no system keeping a locked record of the rate that applied on a specific date.
* Compiling a billing statement for Rebisco requires pulling together data from multiple files by hand, which is time-consuming and error-prone.
* An extra fee called "Mano" applies to deliveries over 100 boxes — currently tracked manually and can be potentially be missed.

### Payroll
* Driver pay is calculated weekly based on trips completed, truck type, and adjustments for absences or night shift hours — all done manually in Excel.
* Special cases — like a driver assigned a 6-wheel truck but using a 4-wheel — require manual rate corrections with no clear paper trail.

***

## 3. What the System Will Do

Here's a breakdown of everything that will be built across the three phases.

### Phase 1 — Getting the Basics Online

The first phase is all about moving from scattered Excel files to a single, organized online system. No complex automation yet — just clean digital records and a proper dispatch board.

**Driver, Truck & Outlet Records**
* A database of all drivers, trucks (with plate numbers and type), and delivery outlets.
* Drivers and trucks are paired by default, so assignments don't need to be reconfigured from scratch every day.

**Digital Dispatch Board**
* A daily schedule that replaces the Excel dispatch sheet — showing all trips for the day with recommended assigned drivers and trucks.
* Driver and truck assignments can be reassigned manually.
* Last-minute trips can be added directly into the system with an automatic timestamp and date record.
* Dispatcher may manually flag statuses of certain trips.
* Incomplete deliveries can be carried over to the next day while preserving the original billing date.

**Waybill Management**
* The system auto-generates suggested waybill numbers, which the dispatcher may modify or confirm.
* The auto-generation follows a set of conditions depending on the warehouse.
* Each waybill is linked to its Rebisco Freight Order (FO) number.

**Role-Based Access Control**
* Access to the system is governed by role-based permissions. Each role is restricted to the screens and actions relevant to their function.

### Phase 2 — Automating the Math

Phase 2 addresses the most time-intensive operational tasks — automated billing computation and driver payroll calculation. Once this is done, most of the heavy lifting happens automatically.

**Freight Rates Management**
* The DOE rates matrix is stored in the system, organized by area, truck type, and fuel price range.
* When rates are updated each week, previous trips are unaffected — the system locks in the rate that was applicable on each trip's date.
* A full history of rate changes is kept for reference and audit purposes.

**Semi-Automated Billing**
* Billing amounts are calculated automatically based on each trip's area, truck type, and the applicable DOE rate for that date.
* The rates for the location that is the farthest from the company’s reference point will be used if there are two different drop-off locations using the same truck.
* The "Mano" extra fee is automatically applied when a delivery exceeds 100 boxes.
* Bad-order (backload) returns can be billed separately and tracked alongside regular trips.
* Completed, POD-cleared trips can be grouped into a billing batch and exported in Rebisco's required format — ready to submit.
* Trips with unusual details (e.g., wrong truck type) are flagged for manual review before billing is finalized.
* The billing view should be able to accomodate new columns.

**Driver Payroll**
* Weekly payroll is computed automatically based on completed trips, truck type, and applicable rates.
* Absences, night shift differentials, and special cases are accounted for.
* SSS, PhilHealth, and Pag-IBIG deductions are calculated and prorated automatically.
* 13th month pay is accumulated and tracked throughout the year.
* A printable payslip is generated for each driver each pay period, with details of their trip.

### Phase 3 — Visibility & Alerts

The final phase consolidates all system components and provides management with a centralized view of operations — eliminating the need to manually search across files or follow up through messaging platforms.

**Proof of Delivery Tracking**
* Each freight order has a running POD status such as Pending, Submitted, No Sign, Missing Stock, Missing Waybill, No Stamp, GRS Issue, Unreturned Invoice, Confiscated, Verified, Cleared, Forced Close, Others (with notes). If possible, it should be buttons.
* The system logs the changes of the POD statuses.
* The system tracks the age (business days) of each POD.
* The system highlights each row depending on conditions with regards to its statuses and its age.

**Management Dashboard & Reports**
* A simple overview screen showing today's active trips, pending PODs, overdue submissions, and billing status at a glance.
* Reports for billing summaries and payroll by period — exportable to Excel or PDF.
* A driver history log showing which drivers have served which outlets is useful for managing route assignments.

***

## 4. Who's Working on This

This is a small, personal project handled by a two-person team:

| Team Member | Role |
| :--- | :--- |
| **Lead Developer** | System analysis, design, and development. Handles most of the technical implementation, scheduling, and client communication. |
| **QA Tester / Support** | Documentation, scheduling coordination, and user testing. Assists with reviewing outputs at each milestone. |

*Development is done on a part-time basis alongside other work commitments. To complete this project in 4 months, the lead developer commits approximately 14 hours per week (roughly 2 hours on weekdays and extended sessions on days off), and the support member contributes around 8 hours per week for testing and documentation.*

***

## 5. Estimated Timeline

All three phases are targeted for completion within 4 months. To hit this timeline, the lead developer commits approximately 14 hours per week, and the support member contributes around 4 hours per week for QA and documentation. Each phase has its own completion milestone, and payment is tied to those milestones.

| Milestone | Month 1 | Month 2 | Month 3 | Month 4 |
| :--- | :---: | :---: | :---: | :---: |
| Kickoff, Requirements & Architecture | ✓ | | | |
| Phase 1 Development | ✓ | ✓ | | |
| Phase 1 QA, Review & Sign-off | | ✓ | | |
| Phase 2 Development | | ✓ | ✓ | |
| Phase 2 QA, Review & Sign-off | | | ✓ | |
| Phase 3 Development | | | ✓ | ✓ |
| Phase 3 QA, Final Review & Handover | | | | ✓ |

*If either party needs to pause or extend the timeline, this can be agreed on in writing. The schedule is flexible as long as both sides are informed.*

***

## 6. Payment

The total cost of the project is PHP 260,000.00. Payment is milestone-based with a standard 30% downpayment upon signing. The remaining balance is released in three installments tied to phase completions — each triggered only after AngeLoyal has reviewed and approved the delivered features.

### 6.1 Rate & Hour Basis

The project cost is computed using industry-standard freelance rates for the Philippines, applied to the estimated hours required per role across all four months:

| Role | Hourly Rate | Est. Hours | Amount (PHP) | Basis |
| :--- | :--- | :--- | :--- | :--- |
| Lead Developer<br>(System Analysis +<br>Full-Stack Development) | ₱1,000 / hr | 200 hrs | **200,000** | ~14 hrs/week<br>× 16 weeks |
| QA Tester / Support<br>(Testing, Documentation,<br>UAT) | ₱500 / hr | 120 hrs | **60,000** | ~8 hrs/week<br>× 16 weeks |
| **TOTAL** | | **320 hrs** | **260,000** | |

*Lead Developer rate of ₱1,000/hour reflects the senior-level scope: system analysis, database design, full-stack development, and client-facing communication — aligned with the upper range for freelance web/system developers in the Philippines (₱500–₱1,000/hour, industry standard as of 2025).*

*QA Tester / Support rate of ₱500/hour is based on the average hourly equivalent for freelance QA testers in the Philippines (approximately ₱477/hour per SalaryExpert, 2025).*

*The hour estimates above cover active working hours — coding, testing, reviewing, and documenting. Coordination and communication overhead is absorbed within these figures.*

### 6.2 Hour Breakdown by Phase

To further substantiate the estimate, here is how the 320 total hours are distributed across each phase:

| Phase | Dev (hrs) | QA (hrs) | Total (hrs) | Dev Cost | QA Cost |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Analysis & Architecture<br>(pre-Phase 1) | 20 | 10 | **30** | 20,000 | 5,000 |
| Phase 1 — Dispatch,<br>Records & Waybills | 55 | 30 | **85** | 55,000 | 15,000 |
| Phase 2 — Billing, Rates<br>Matrix & Payroll | 75 | 50 | **125** | 75,000 | 25,000 |
| Phase 3 — POD Tracking,<br>Alerts & Reports | 50 | 30 | **80** | 50,000 | 15,000 |
| **TOTAL** | **200** | **120** | **320** | **200,000** | **60,000** |

### 6.3 Payment Schedule

Payments are released in four tranches — one down payment upon signing and one per phase completion. No phase payment is due until AngeLoyal has confirmed the deliverables are working as described.

| # | When Payment is Due | What Has Been Completed | Amount (PHP) |
| :---: | :--- | :--- | :--- |
| 1 | **Upon signing this agreement —<br>Downpayment (30%)** | Project kickoff;<br>requirements<br>review; database &<br>system<br>architecture | **78,000** |
| 2 | **Phase 1 sign-off (20%)** | Dispatch board,<br>driver & truck<br>records, waybill<br>system | **52,000** |
| 3 | **Phase 2 sign-off (30%)** | Billing, DOE rates<br>matrix, payroll<br>module | **78,000** |
| 4 | **Phase 3 sign-off — Project Completion (20%)** | POD tracking,<br>alerts, dashboard<br>& reports, training | **52,000** |
| | **TOTAL** | | **260,000** |

*"Sign-off" means AngeLoyal has reviewed and confirmed the delivered features are working as described. A review period of up to 5 business days is given per phase before sign-off is requested.*

*The 30% downpayment is standard practice for freelance, project-based engagements in the Philippines. It covers upfront work done before any visible features are built — requirements review, system architecture, and database design — and confirms both parties' commitment to the project.*

*Phase 2 carries the largest milestone payment (30%) because it covers the most technically complex modules: the automated billing and the payroll computation system.*

***

## 7. Scope of Work

### Included in the Project
* Everything described in Section 3 of this proposal.
* A round of feedback and revisions per sprint, based on AngeLoyal's review.
* A walkthrough/training session at the end of the project.
* Basic documentation so staff know how to use the system.
* Maintenance and bug fixes for anything that breaks during the development itself and 30 days after sign-off of each phase.

### Not Included
* Features or changes requested outside of what's described in this proposal (these can be discussed and priced separately).
* Currently, there are no foreseeable monthly subscription fees, cloud hosting costs, or additional hardware required. If ever both parties agree to a solution that requires any — AngeLoyal will need to arrange and pay for the fees.
* Ongoing maintenance after the project is completed (can be arranged separately).

***

## 8. A Few Ground Rules

To keep things smooth for both sides:

* AngeLoyal should designate one person as the main point of contact (POC) for feedback and approvals.
* If a feature needs to be changed or added beyond what's described here, both parties agree before work begins.
* If the timeline needs to shift (due to workload, feedback delays, etc.), the team will communicate this clearly in advance.
* All data, processes, and information shared during this project will be kept confidential.
* Each phase is considered complete when AngeLoyal formally confirms approval (a written message or email is sufficient).
* Upon receipt of final payment, full ownership of all source code, documentation, and developed assets transfers to AngeLoyal Logistics.

— End of Proposal —
