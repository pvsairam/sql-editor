/**
 * Curated list of widely used Oracle Fusion Cloud tables/views for completion before (or without) a
 * live schema load. Names are the documented base tables; descriptions are short module hints.
 */
export interface CatalogTable {
  name: string;
  module: string;
  desc: string;
}

const t = (module: string, rows: [string, string][]): CatalogTable[] => rows.map(([name, desc]) => ({ name, module, desc }));

export const FUSION_TABLES: CatalogTable[] = [
  ...t('HCM', [
    ['PER_ALL_PEOPLE_F', 'Person records (date-effective)'],
    ['PER_PERSON_NAMES_F', 'Person names by name type (date-effective)'],
    ['PER_ALL_ASSIGNMENTS_M', 'Work relationships / assignments (date-effective)'],
    ['PER_PERIODS_OF_SERVICE', 'Periods of service (hire / termination dates)'],
    ['PER_EMAIL_ADDRESSES', 'Person e-mail addresses'],
    ['PER_PHONES', 'Person phone numbers'],
    ['PER_NATIONAL_IDENTIFIERS', 'National identifiers'],
    ['PER_CITIZENSHIPS', 'Citizenships'],
    ['PER_USERS', 'Application users linked to persons'],
    ['PER_USER_ROLES', 'Roles granted to users'],
    ['PER_ROLES_DN', 'Role definitions'],
    ['PER_JOBS_F', 'Jobs (date-effective)'],
    ['PER_GRADES_F', 'Grades (date-effective)'],
    ['HR_ALL_ORGANIZATION_UNITS', 'Organizations / departments'],
    ['HR_LOCATIONS_ALL', 'Locations'],
    ['HR_ALL_POSITIONS_F', 'Positions (date-effective)'],
    ['PAY_ELEMENT_TYPES_F', 'Payroll element definitions'],
    ['PAY_ELEMENT_ENTRIES_F', 'Element entries'],
    ['PAY_INPUT_VALUES_F', 'Element input values'],
    ['PAY_RUN_RESULTS', 'Payroll run results'],
    ['PAY_RUN_RESULT_VALUES', 'Payroll run result values'],
    ['PAY_PAYROLL_REL_ACTIONS', 'Payroll relationship actions'],
    ['ANC_PER_ABS_ENTRIES', 'Absence entries']
  ]),
  ...t('Financials', [
    ['GL_LEDGERS', 'Ledgers'],
    ['GL_CODE_COMBINATIONS', 'Accounting flexfield combinations'],
    ['GL_JE_BATCHES', 'Journal batches'],
    ['GL_JE_HEADERS', 'Journal headers'],
    ['GL_JE_LINES', 'Journal lines'],
    ['GL_BALANCES', 'Account balances'],
    ['GL_PERIODS', 'Accounting calendar periods'],
    ['GL_PERIOD_STATUSES', 'Period open/close status'],
    ['GL_DAILY_RATES', 'Daily currency conversion rates'],
    ['AP_INVOICES_ALL', 'Payables invoices'],
    ['AP_INVOICE_LINES_ALL', 'Payables invoice lines'],
    ['AP_INVOICE_DISTRIBUTIONS_ALL', 'Payables invoice distributions'],
    ['AP_PAYMENT_SCHEDULES_ALL', 'Payables payment schedules'],
    ['AP_INVOICE_PAYMENTS_ALL', 'Payments applied to invoices'],
    ['AP_CHECKS_ALL', 'Payments (checks / electronic)'],
    ['AP_HOLDS_ALL', 'Invoice holds'],
    ['RA_CUSTOMER_TRX_ALL', 'Receivables transaction headers'],
    ['RA_CUSTOMER_TRX_LINES_ALL', 'Receivables transaction lines'],
    ['AR_PAYMENT_SCHEDULES_ALL', 'Receivables payment schedules'],
    ['AR_CASH_RECEIPTS_ALL', 'Cash receipts'],
    ['AR_RECEIVABLE_APPLICATIONS_ALL', 'Receipt applications'],
    ['FA_ADDITIONS_B', 'Fixed assets (base)'],
    ['FA_ADDITIONS_TL', 'Fixed assets (translated)'],
    ['FA_BOOKS', 'Fixed asset books'],
    ['FA_DEPRN_SUMMARY', 'Depreciation summary'],
    ['FA_CATEGORIES_B', 'Asset categories'],
    ['XLA_AE_HEADERS', 'Subledger journal entry headers'],
    ['XLA_AE_LINES', 'Subledger journal entry lines'],
    ['XLA_TRANSACTION_ENTITIES', 'Subledger transaction entities'],
    ['CE_BANK_ACCOUNTS', 'Bank accounts'],
    ['CE_STATEMENT_HEADERS', 'Bank statement headers'],
    ['CE_STATEMENT_LINES', 'Bank statement lines'],
    ['IBY_PAYMENTS_ALL', 'Payments (Payments module)'],
    ['ZX_LINES', 'Tax lines'],
    ['ZX_RATES_B', 'Tax rates']
  ]),
  ...t('Trading Community', [
    ['HZ_PARTIES', 'Parties (persons, organizations)'],
    ['HZ_CUST_ACCOUNTS', 'Customer accounts'],
    ['HZ_CUST_ACCT_SITES_ALL', 'Customer account sites'],
    ['HZ_CUST_SITE_USES_ALL', 'Customer site uses'],
    ['HZ_LOCATIONS', 'Locations / addresses'],
    ['HZ_PARTY_SITES', 'Party sites'],
    ['HZ_ORGANIZATION_PROFILES', 'Organization profiles'],
    ['HZ_PERSON_PROFILES', 'Person profiles']
  ]),
  ...t('Procurement', [
    ['PO_HEADERS_ALL', 'Purchase order headers'],
    ['PO_LINES_ALL', 'Purchase order lines'],
    ['PO_LINE_LOCATIONS_ALL', 'Purchase order schedules'],
    ['PO_DISTRIBUTIONS_ALL', 'Purchase order distributions'],
    ['POR_REQUISITION_HEADERS_ALL', 'Requisition headers'],
    ['POR_REQUISITION_LINES_ALL', 'Requisition lines'],
    ['POR_REQ_DISTRIBUTIONS_ALL', 'Requisition distributions'],
    ['POZ_SUPPLIERS', 'Suppliers'],
    ['POZ_SUPPLIER_SITES_ALL_M', 'Supplier sites'],
    ['RCV_SHIPMENT_HEADERS', 'Receiving shipment headers'],
    ['RCV_SHIPMENT_LINES', 'Receiving shipment lines'],
    ['RCV_TRANSACTIONS', 'Receiving transactions']
  ]),
  ...t('SCM', [
    ['EGP_SYSTEM_ITEMS_B', 'Items (base)'],
    ['EGP_SYSTEM_ITEMS_TL', 'Items (translated)'],
    ['EGP_CATEGORIES_B', 'Item categories'],
    ['EGP_ITEM_CATEGORIES', 'Item category assignments'],
    ['INV_ORG_PARAMETERS', 'Inventory organization parameters'],
    ['INV_MATERIAL_TXNS', 'Material transactions'],
    ['INV_ONHAND_QUANTITIES_DETAIL', 'On-hand quantities'],
    ['DOO_HEADERS_ALL', 'Order management headers'],
    ['DOO_LINES_ALL', 'Order management lines'],
    ['DOO_FULFILL_LINES_ALL', 'Fulfilment lines'],
    ['WSH_NEW_DELIVERIES', 'Shipping deliveries'],
    ['WSH_DELIVERY_DETAILS', 'Shipping delivery details']
  ]),
  ...t('Projects', [
    ['PJF_PROJECTS_ALL_B', 'Projects (base)'],
    ['PJF_PROJECTS_ALL_VL', 'Projects (view with translation)'],
    ['PJF_PROJ_ELEMENTS_B', 'Project tasks / elements'],
    ['PJC_EXP_ITEMS_ALL', 'Project expenditure items']
  ]),
  ...t('Common', [
    ['FND_LOOKUP_VALUES', 'Lookup values (view)'],
    ['FND_LOOKUP_VALUES_B', 'Lookup values (base)'],
    ['FND_LOOKUP_TYPES', 'Lookup types'],
    ['ESS_REQUEST_HISTORY', 'Scheduled process (ESS) request history']
  ])
];

export const FUSION_TABLE_MAP = new Map(FUSION_TABLES.map((x) => [x.name, x]));
