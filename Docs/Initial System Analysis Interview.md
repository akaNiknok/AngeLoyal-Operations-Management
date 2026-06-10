Here is a rough English transcription of the initial system analysis interview. The conversation has been translated from Taglish (Tagalog-English) to English, with sentence structures refined for natural speech flow and professional clarity. 
 
Based on the context of the conversation, the four speakers have been identified and labeled as follows:
*   **Lead Analyst:** The primary person asking questions, mapping out the system requirements, and proposing the final solution/budget.
*   **Support Analyst:** The secondary analyst clarifying specific data points, edge cases, and technical details.
*   **Operations Manager 1:** The main representative from the logistics company, explaining the day-to-day operations, routing, billing, and driver management.
*   **Payroll/Admin Manager (Operations Manager 2):** Discusses the payroll system, statutory deductions, and employee compensation.
 
***
 
**[00:00 - 05:00] Dispatching, Routing, and System Inputs**
 
**Operations Manager 1:** If I have a trip tomorrow, it should be here by tonight. But since their system changed...
 
**Lead Analyst:** Rebisco's system?
 
**Operations Manager 1:** Yes. It became unpredictable. Sometimes it's slow, sometimes it's heavily delayed. It gets emailed to us. 
 
**Lead Analyst:** How often does the Rebisco system change?
 
**Operations Manager 1:** Not that often, but they recently changed the name of their auto-system. 
 
**Lead Analyst:** So, basically, do they send it at night or in the morning?
 
**Operations Manager 1:** It’s random now. It could be night or random times. Like this one, yesterday at 3:31 PM, this was my trip for today... but sent yesterday afternoon.
 
**Lead Analyst:** Ah, okay. As long as they send it the day before or the night before.
 
**Operations Manager 1:** Yes, the day before. So, this can still be processed manually. I don't really need...
 
**Lead Analyst:** And what you receive is an Excel file? Is this what you printed out?
 
**Operations Manager 1:** Yes. For our reference... that's for their monitoring.
 
**Lead Analyst:** Their monitoring?
 
**Operations Manager 1:** Yes. So, every time I receive this, I download it and save it here in my "Routes" folder. From here, that big file, I reduce it to... for example, the trips for today. Here it is. But this one, I don't change anything here. This comes directly from them. 
 
**Support Analyst:** Do you input anything there?
 
**Operations Manager 1:** Only on this part. What happens is that the sequence isn't consecutive anymore because I compress the trips. Instead of treating this as two separate trips, we combine it into one if it fits the truck, or depending on what I tell the boss. I tell him we can combine these so it doesn't auto-assign. Because if it auto-assigns, it will just allocate one per route, right? Since one truck can handle it, sometimes we have a choice. But we can't do that for all of them.
 
**Lead Analyst:** So, there's human intervention on those highlighted parts. It can be automated, but there has to be a double-check by a human. 
 
**Operations Manager 1:** Yes. So, this process might not be fully automated. It can just suggest.
 
**Lead Analyst:** It can suggest that this truck can accommodate this load, and these are the possible plate numbers.
 
**Operations Manager 1:** Yes. But when it comes to us, we have to check if the driver's attitude is suited for that route. There's a behavioral application to it. 
 
**Support Analyst:** What are the cases where the person manually intervenes?
 
**Operations Manager 1:** For example, if there's damage to the truck, he can't be combined with a heavy load. So, you really need human intervention there. 
 
**Lead Analyst:** So, it can just be suggestive, but with a bit of a manual override. That's a big factor because, like I said, they shouldn't repeat routes unnecessarily. 
 
**Operations Manager 1:** Historically, you can see if the trips are consecutive. 
 
**Lead Analyst:** Yes, we can track that. Like, "Last week he came from there, so let's avoid assigning him there again."
 
**Operations Manager 1:** Exactly, just a suggestion. The system should suggest that it shouldn't be him. Because that's my problem right now, I don't always notice it. After three weeks, he's been there 25 times. The driver will complain, "Boss, I just came from there, maybe someone else can do it." 
 
**Support Analyst:** So, there's a given number of times a truck can travel to a specific outlet or location?
 
**Operations Manager 1:** Yes, per outlet. Because there are outlets that are really difficult to deliver to. If you send the same driver repeatedly within three weeks, they will complain. But we can't do anything if that's really the requirement of the truck—if his truck is the only one big enough and he's the only one allowed. That's a reasonable exception. 
 
**Lead Analyst:** What are these color codes here?
 
**Operations Manager 1:** This color indicates which company it is. Blue is SM, Watermark, Robinsons, etc.
 
**Lead Analyst:** Does your decision here affect the quantity and area?
 
**Operations Manager 1:** No, it’s more on this number and our truck type. If you look at it, our truck type is a 4-wheeler. Those are our Travis trucks. There are plate numbers here, so I have five 4-wheelers. Then, this is the quantity. 
 
**[05:00 - 10:00] Handling Fees ("Mano"), Waybills, and Driver Assignments**
 
**Operations Manager 1:** When it comes to billing, if the quantity hits 100 boxes and above, we have an extra "mano" (handling fee). That's an additional reimbursable fee. We pay that to the outlet to expedite the unloading. It's additional help for the delivery team. 
 
**Lead Analyst:** So, that's what we want to capture. If it hits 100, it should automatically bill an extra 200 pesos. Do you bill that to Rebisco?
 
**Operations Manager 1:** Yes, to Rebisco. That's actually one thing I sometimes overlook because it's completely manual right now. 
 
**Support Analyst:** So for quantities above 100, there's a "mano". Is "mano" just a local term?
 
**Operations Manager 1:** Yes, "mano" is a delivery term. It's like a facilitation fee. But Rebisco honors that; for 100 boxes and above, we are entitled to it. It's a fixed amount per box.
 
**Lead Analyst:** Okay, understood. So after you fill this out, you send it to them? Do you put the 111?
 
**Operations Manager 1:** No, that's what they request. For example, one outlet requires three trucks. So, right now, I assign them designated per FO (Freight Order). You can adjust it to be considered per FO. 
 
**Lead Analyst:** So, when you assign a driver, does the driver have their own assigned truck? Do you have a database or a list for that?
 
**Operations Manager 1:** Yes, this is it. The plate numbers. We just have a list. I just copy-paste it for each one. I just highlight it when I assign them, so I know who is left. Because sometimes you get confused when you send it. A driver might say, "Boss, my trips are doubled." I wouldn't notice I assigned him twice. 
 
**Lead Analyst:** So, for example, today's operations are done. The next day, what you'll do is download this Excel, and copy-paste the driver list again?
 
**Operations Manager 1:** Yes. For example, this week, I started on Monday. It's empty. This is your lineup for the next day. If someone is absent on Monday, he's not listed there. It's either we decide if we'll move him up... because diesel is expensive. If you deploy him and there are no trips, you have to send him home. Because they are our regular employees. If he doesn't have a name there, he knows he's on standby.
 
**Support Analyst:** Unless someone calls in with an extra requirement?
 
**Operations Manager 1:** Exactly. Sometimes there's a call saying, "Sir, do you have an available 6-wheeler?" If no one is assigned, I will manually input it for the record. Just for processing, because these are all trips. So if there's an addition today, while he's driving today, I'll record it. Since it wasn't finished yesterday, I'll count him for today. 
 
**Lead Analyst:** And that is considered today for billing purposes?
 
**Operations Manager 1:** Yes, for billing. We'll add it in the email too, manually. We need a record so we know his trip crossed over to the next day.
 
**[10:00 - 15:00] Proof of Delivery (POD) and Discrepancies**
 
**Lead Analyst:** Can you add a driver in one day? Like, if Rebisco just calls?
 
**Operations Manager 1:** Yes, they call. They don't send a new Excel file. Usually, it's just via Viber. So I just manually insert it. It's occasional, not a heavy task. 
 
**Lead Analyst:** What are the cases why a delivery isn't finished the night before? 
 
**Operations Manager 1:** It depends on the outlet. Sometimes there are too many deliveries happening at the store. At the end of the day, later this afternoon, we will update if it's finished or not. If not, they will report that they missed the cut-off. Not received. So, who tracks if it's finished or not? We monitor it on the same Excel sheet. 
 
**Lead Analyst:** Do you send that Excel back to them?
 
**Operations Manager 1:** When I send it on Messenger, it's either a screenshot or a paper trail. 
 
**Lead Analyst:** You check the Excel manually. We want to see a Proof of Delivery (POD). How do you currently know if a delivery is actually finished?
 
**Operations Manager 1:** When they return to the warehouse, they should send their receipts. Actually, they return weekly. But that doesn't mean they can just forget to submit it. There is a time limit for them to submit. Within 3 days, if you don't submit your clearance, there's a penalty charge. The warehouse charges it to us. 
 
**Support Analyst:** What exactly is the proof of delivery?
 
**Operations Manager 1:** This waybill. Once I assign a driver, they get a blank copy of this. They will write the FO, the assigned waybill number, and the plate number. Rebisco provides these blank forms. These are the invoices they hold. This becomes the proof of delivery once the receiving store signs it. When they return all these receipts to the warehouse POD department, the POD will check if it's complete. If there are cross-outs or missing items, they have to return and fix it. 
 
**[15:00 - 20:00] Penalties, SLA Monitoring, and Issue Resolution**
 
**Lead Analyst:** Are they required to send the POD immediately on the same day?
 
**Operations Manager 1:** If possible, yes. But if there's a problem, they have a maximum of 3 days. 
 
**Lead Analyst:** What causes them to take the full 3 days? 
 
**Operations Manager 1:** Sometimes they forget to get the store's stamp, so they have to go back for it. Most of the time, if there are no issues, it shouldn't take 3 days. 
 
**Support Analyst:** Are there discrepancies in the delivery? Like missing or lost items?
 
**Operations Manager 1:** Yes, you'll see all of that there. When you return the POD, if you are missing a delivery—let's say I gave you 100 cartons and 5 receipts—those 5 receipts must perfectly match the 100 cartons. You have 3 days to resolve any discrepancies. You can't just invent a signature. 
 
**Lead Analyst:** So you really need to monitor this. If something takes too long, it means there's a problem they haven't fixed. 
 
**Operations Manager 1:** Exactly. That needs an alarm. It needs to notify us that 3 days have passed and they haven't submitted. What usually happens is they are requesting a CCTV review because an item went missing. So there should be notifications before the 3-day mark. Because we handle so many trips, we need an alert if a POD is pending. Right now, checking that is highly manual. 
 
**Lead Analyst:** Because you get fined if they don't submit within 3 days?
 
**Operations Manager 1:** Yes, we get fined immediately. 500 pesos per instance. So we want a prompt from our end saying, "Hey, it's almost 3 days, what's happening?"
 
**[20:00 - 25:00] Rates, Billing, and the Department of Energy (DOE)**
 
**Lead Analyst:** Going back to the Excel from earlier. You said within 3 days they need to provide the POD. How do you know real-time if a trip isn't finished?
 
**Operations Manager 1:** It's manual. The drivers will call us. Usually, within the day, they notify us, "Boss, we can't be received anymore." Cut-off times for stores are usually 2 PM or 3 PM. If you're late, you can't unload. 
 
**Lead Analyst:** So, after a route is assigned and completed, how does it move to billing? 
 
**Operations Manager 1:** When it's complete, technically, we gather the PODs after a week. If we can automate this, the system should draft the billing automatically. But there are many variables. We have a matrix for rates versus diesel prices. It's not fully automated because the Department of Energy (DOE) dictates the common fuel rate, and we follow that as our base rate.
 
**Support Analyst:** Do you manually check the DOE rates?
 
**Operations Manager 1:** Yes, we check it. Or we base it on our internal matrix. We have a database of the fare matrix. It depends on the area and the truck type. 
 
**[25:00 - 35:00] Invoicing, Fuel Matrices, and Redeliveries**
 
**Operations Manager 1:** For example, the area is Las Piñas. The fuel matrix is 50.01 to 55 pesos per liter. If the DOE rate is 52 pesos, it falls in this bracket. If it's Las Piñas, a 6-wheeler rate is 3,000 pesos, and a 4-wheeler rate is 2,500 pesos. Every Tuesday, the fuel rate changes based on the DOE. So, we wait for the DOE announcement, and I manually select the bracket—say, 55.01 to 60 pesos, which makes the rate 3,300. I manually input 3,300. 
 
**Lead Analyst:** Are you just copy-pasting this?
 
**Operations Manager 1:** Yes, auto-copy paste. Once we have this, it's considered good for billing. At the end of the week, we print it. 
 
**Lead Analyst:** I want to make sure I understand this. If I see the waybill is "posted", it means it can be billed. Based on the plate number and the area, the system should auto-decide the rate, because it's per waybill. 
 
**Operations Manager 1:** Yes, per day. And if there is a store return—say, half a truck of unsold goods—we charge them a backload fee. But we only bill Rebisco, we don't deal with the outlet. 
 
**Support Analyst:** What if your rates on Monday and Tuesday have different pricing because of the DOE update? 
 
**Operations Manager 1:** It crosses over. There is a cut-off. If Monday (May 4) fuel is 50 pesos, we will wait to see if May 5 stays the same or if it drops. The billing adjusts accordingly.
 
**[35:00 - 40:00] Payroll, Statutory Deductions, and Employee Tracking**
 
**Payroll/Admin Manager (Ops Manager 2):** I have a question regarding payroll. Will the payroll auto-compute? Actually, all our drivers are on minimum wage, so we don't have complex compensation or withholding taxes. But the 13th month pay needs to be computed. The cut-off for salary is weekly. We also need to compute statutory deductions—SSS, PhilHealth, Pag-IBIG. 
 
**Lead Analyst:** Are those statutory deductions prorated?
 
**Payroll/Admin Manager:** If they work 5 days, the deductions are different. Do we prorate that?
 
**Lead Analyst:** I haven't tried automating the exact pro-ration for SSS and Pag-IBIG yet, but I know it's doable because large companies automate it. We can integrate their matrices. 
 
**Operations Manager 1:** There's a fixed rate. But if there's an absence, it changes. It's computed per month. 
 
**Lead Analyst:** What about attendance? How do you track if they are absent?
 
**Operations Manager 1:** We have a time-in, time-out system. They have a timesheet with their location. We know if they are on their second drop because they take a picture. 
 
**[40:00 - End] Finalizing Project Scope, Budget, and Architecture**
 
**Lead Analyst:** Okay, I'm looking at the big picture here. What we want is for you to just select the confirmed trips, and they automatically transfer to billing. We will include parking, packaging tape, back orders, and the "mano" fee. We will follow Rebisco's exact format. 
 
**Operations Manager 1:** Yes, we need to attach the physical PODs. Because even if the system says it's booked, the physical waybill is the only proof that it's done. If there's a redelivery—let's say 90% was delivered, but 10% was delayed because of a flat tire—we need to report that. 
 
**Lead Analyst:** For redeliveries, we will separate it. We will produce Waybill 1 and Waybill 2. We'll use the same number but append "-R" (e.g., 10236-R). That way, it generates two billings, and you just attach the original waybill and the chat log with Rebisco as proof of the delay.
 
**Operations Manager 1:** That makes sense. 
 
**Lead Analyst:** I'll draft a proposal and send it to your Boss. We will list what we can automate and provide options depending on your budget. For a project this size, running for about 2 months, it will cost around 200,000 pesos. This includes system analysis, interviews, mapping your Excel files and billing forms, handling edge cases, and building the flow from booking to billing. 
 
**Operations Manager 1:** Will this be on a custom software or cloud-based?
 
**Lead Analyst:** We will use Google Sheets as the backend database for now since you don't have enough volume to require a heavy, expensive server. It's cloud-based, free, and very easy to maintain. Once your company scales massively, we can migrate it to a custom Software-as-a-Service (SaaS) platform, but for now, Google Sheets with automated scripts is your most cost-effective and reliable option. 
 
**Operations Manager 1:** Okay, that sounds like a good plan. Send over the proposal so we can review it.
 
**Lead Analyst:** Will do. Thank you for your time.
