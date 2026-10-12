// Dev-org seed data for Pipeline-Aware Forecast testing (Developer Edition / sandbox ONLY).
// Run: sf apex run -o <your-dev-org-alias> -f scripts/seed-dev-org.apex
// Creates 4 products (PAF-001, paf-002, PAF-003, PAF-999) and 10 "PAF Seed" Opportunities with line items.
// Opportunities 01 and 02 reproduce the README worked example with shipOffsetDays = 7.
// Undo with scripts/cleanup-seed.apex. Safe to re-run (it aborts if PAF products already exist).
if ([SELECT COUNT() FROM Product2 WHERE ProductCode LIKE 'PAF%'] > 0) {
    System.debug('SEED ABORT: PAF products already exist');
    return;
}
Pricebook2 stdPb = [SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1];
Pricebook2 usePb = [SELECT Id FROM Pricebook2 WHERE IsStandard = false AND Name = 'Standard' AND IsActive = true LIMIT 1];

// Salesforce ProductCode for PAF-002 is deliberately lowercase to exercise normalised matching.
List<Product2> prods = new List<Product2>{
    new Product2(Name = 'PAF Test Board A', ProductCode = 'PAF-001', IsActive = true),
    new Product2(Name = 'PAF Test Board B', ProductCode = 'paf-002', IsActive = true),
    new Product2(Name = 'PAF Test Board C', ProductCode = 'PAF-003', IsActive = true),
    new Product2(Name = 'PAF Unmatched Item', ProductCode = 'PAF-999', IsActive = true)
};
insert prods;
Map<String, Id> prodId = new Map<String, Id>();
for (Product2 p : prods) prodId.put(p.ProductCode.toUpperCase(), p.Id);

List<PricebookEntry> pbes = new List<PricebookEntry>();
for (Product2 p : prods) {
    pbes.add(new PricebookEntry(Pricebook2Id = stdPb.Id, Product2Id = p.Id, UnitPrice = 10, IsActive = true));
}
insert pbes;
List<PricebookEntry> pbes2 = new List<PricebookEntry>();
for (Product2 p : prods) {
    pbes2.add(new PricebookEntry(Pricebook2Id = usePb.Id, Product2Id = p.Id, UnitPrice = 10, IsActive = true));
}
insert pbes2;
Map<String, Id> pbeId = new Map<String, Id>();
for (PricebookEntry e : [SELECT Id, Product2.ProductCode FROM PricebookEntry WHERE Pricebook2Id = :usePb.Id AND Product2.ProductCode LIKE 'PAF%']) {
    pbeId.put(e.Product2.ProductCode.toUpperCase(), e.Id);
}

// name, stage, closeDate offset (days from today), items (code => qty)
// Deals 01 and 02 reproduce the README worked example when shipOffsetDays = 7:
//   01: 300 @ 50%, closes +13 -> ships day 20      02: 200 @ 20%, closes +23 -> ships day 30
List<List<Object>> plan = new List<List<Object>>{
    new List<Object>{'PAF Seed 01', 'Value Proposition',  13, new Map<String,Integer>{'PAF-001' => 300}},
    new List<Object>{'PAF Seed 02', 'Needs Analysis',     23, new Map<String,Integer>{'PAF-001' => 200}},
    new List<Object>{'PAF Seed 03', 'Negotiation/Review',  5, new Map<String,Integer>{'PAF-002' => 120}},
    new List<Object>{'PAF Seed 04', 'Proposal/Price Quote',20, new Map<String,Integer>{'PAF-002' => 80, 'PAF-003' => 60}},
    new List<Object>{'PAF Seed 05', 'Prospecting',        45, new Map<String,Integer>{'PAF-003' => 500}},
    new List<Object>{'PAF Seed 06', 'Qualification',      30, new Map<String,Integer>{'PAF-001' => 40, 'PAF-999' => 25}},
    new List<Object>{'PAF Seed 07', 'Id. Decision Makers', 9, new Map<String,Integer>{'PAF-003' => 90}},
    new List<Object>{'PAF Seed 08', 'Perception Analysis',-10, new Map<String,Integer>{'PAF-002' => 30}},
    new List<Object>{'PAF Seed 09', 'Prospecting',       200, new Map<String,Integer>{'PAF-001' => 1000}},
    new List<Object>{'PAF Seed 10', 'Closed Won',         -3, new Map<String,Integer>{'PAF-001' => 70}}
};
List<Opportunity> opps = new List<Opportunity>();
for (List<Object> row : plan) {
    opps.add(new Opportunity(Name = (String)row[0], StageName = (String)row[1],
        CloseDate = Date.today().addDays((Integer)row[2]), Pricebook2Id = usePb.Id));
}
insert opps;
List<OpportunityLineItem> lines = new List<OpportunityLineItem>();
for (Integer i = 0; i < plan.size(); i++) {
    Map<String,Integer> items = (Map<String,Integer>)plan[i][3];
    for (String code : items.keySet()) {
        lines.add(new OpportunityLineItem(OpportunityId = opps[i].Id, PricebookEntryId = pbeId.get(code),
            Quantity = items.get(code), UnitPrice = 10));
    }
}
insert lines;
System.debug('SEED OK: products=' + prods.size() + ' opps=' + opps.size() + ' lines=' + lines.size());
