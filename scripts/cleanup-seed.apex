// Removes ONLY the records created by scripts/seed-dev-org.apex (names/codes starting with PAF).
// Run: sf apex run -o <your-dev-org-alias> -f scripts/cleanup-seed.apex
delete [SELECT Id FROM Opportunity WHERE Name LIKE 'PAF Seed%'];
delete [SELECT Id FROM PricebookEntry WHERE Product2.ProductCode LIKE 'PAF%'];
delete [SELECT Id FROM Product2 WHERE ProductCode LIKE 'PAF%'];
System.debug('CLEANUP OK');
