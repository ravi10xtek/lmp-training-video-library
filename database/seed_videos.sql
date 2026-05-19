-- ══════════════════════════════════════════════════════════
-- LMP Training Library — Bulk Video Slot Insert
-- Run AFTER supabase_schema.sql
-- Inserts all 152 pre-named empty slots from the content doc
-- ══════════════════════════════════════════════════════════

-- Helper: get category/subcat IDs inline
-- All slots start as 'empty' status

-- ── LMP OPERATIONS — People & Roles ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Joe L — master plumber, VP & DBA overview',          (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 1),
('Brad — master electrician & his roles',               (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 2),
('Managers — daily, weekly & monthly duties',           (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 3),
('Plumber — what a day & week looks like',              (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 4),
('Types of customers — 4 types explained',              (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 5),
('Apprentices — training, habits & turning out',        (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 6),
('Helpers — roles, billing & shop duties',              (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 7),
('Bookkeeper — role, access & communication',           (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 8),
('IT & attorney — third party roles',                   (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 9),
('Union contract — pay scales, foreman & levels',       (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 10),
('Manager pay scale, benefits & total package',         (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 11),
('Loch Monster family — expansion vision',              (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='people-roles'), 'empty', 12);

-- ── LMP OPERATIONS — Physical Locations ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('The shop — layout & where everything is',             (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='physical-locations'), 'empty', 1),
('The trucks — setup, stock & what''s inside',          (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='physical-locations'), 'empty', 2),
('The office — layout & organisation',                  (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='physical-locations'), 'empty', 3),
('Mailing address — why it''s different',               (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='physical-locations'), 'empty', 4);

-- ── LMP OPERATIONS — Business Processes ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Quotes vs time & material explained',                 (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 1),
('Bid work — what it means',                            (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 2),
('Good faith estimates',                                (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 3),
('Emergency jobs — process & double time',              (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 4),
('Emergency management — manager on-call duties',       (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 5),
('Invoicing — when, how & who does it',                 (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 6),
('Invoicing — customer types & payment terms',          (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 7),
('On-site invoicing — how it should look',              (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 8),
('Paid time vs billed time',                            (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 9),
('Service fee explained — first job vs return visits',  (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 10),
('Win win win — billing, productivity & bonuses',       (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 11),
('Teams meetings — purpose & agenda',                   (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 12),
('LDR and Binder explained — why we built it',          (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 13),
('Binder scorecard — tracking jobs & invoices',         (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 14),
('LDR fillable forms — design & purpose',               (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 15),
('LDR dispatch forms — first come first serve',         (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 16),
('Manager note taking — what to record per job',        (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 17),
('Phone system — team communication',                   (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 18),
('Collateral damage — parts over-purchasing',           (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 19),
('Scheduling time off — process & what we need',        (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 20),
('Safety on site — confrontational people',             (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 21),
('Plumber responsibility — owning your work & tools',   (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 22),
('Advertising & residential market strategy',           (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='business-processes'), 'empty', 23);

-- ── LMP OPERATIONS — Purchasing & Ordering ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Wholesale accounts — tracking, credit & returns',     (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='purchasing-ordering'), 'empty', 1),
('Credit cards, gas cards & purchase tracking',         (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='purchasing-ordering'), 'empty', 2),
('Ordering items — process, tracking numbers & receipts',(select id from categories where slug='lmp-operations'), (select id from subcategories where slug='purchasing-ordering'), 'empty', 3),
('Truck stock — selling, restocking & billing out',     (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='purchasing-ordering'), 'empty', 4),
('Rental tools — tracking, billing & cost recovery',    (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='purchasing-ordering'), 'empty', 5),
('Union rebate program — electrical & plumbing',        (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='purchasing-ordering'), 'empty', 6);

-- ── LMP OPERATIONS — Standards & Compliance ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Forms — why we fill them & their purposes',           (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 1),
('Reports — weekly data review & decisions',            (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 2),
('Uniforms — appearance standards',                     (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 3),
('Driving habits — we are a billboard',                 (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 4),
('Vehicle maintenance A to Z',                          (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 5),
('What to do — vehicle accident',                       (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 6),
('What to do — mistake on job site',                    (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 7),
('Taking pictures — purpose & method',                  (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 8),
('Warranty — triple check method & prevention',         (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 9),
('Warranty process — recording & tracking',             (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 10),
('Permits — when to pull & when not to',                (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 11),
('Terminology — words used at LMP',                     (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 12),
('Business cards & referrals',                          (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 13),
('Mold — who handles it & what we say',                 (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 14),
('Scheduling water shutdowns',                          (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 15),
('Customer service — callbacks & follow through',       (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 16),
('Contact management — authorities & profiles',         (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 17),
('Disposal fees — what they cover & how to charge',     (select id from categories where slug='lmp-operations'), (select id from subcategories where slug='standards-compliance'), 'empty', 18);

-- ── PROPERTIES & CONTACTS — HOA Management Companies ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('FirstService Residential',                            (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 1),
('Association One',                                     (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 2),
('Sharper Management',                                  (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 3),
('Cities Management',                                   (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 4),
('Guardian Property Management',                        (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 5),
('Compass Management',                                  (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 6),
('Gassen',                                              (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 7),
('Prudden',                                             (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-management'), 'empty', 8);

-- ── PROPERTIES & CONTACTS — HOA & Apartment Properties ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Sunrise Gardens HOA',                                 (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 1),
('Maple Ridge HOA',                                     (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 2),
('Ridgeview Apartments',                                (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 3),
('3300 On the Park',                                    (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 4),
('Greenbrier',                                          (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 5),
('Labelle Park II',                                     (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 6),
('Kenwood Isles',                                       (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 7),
('The Pointe',                                          (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 8),
('Cedar / Calhoun Isles',                               (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 9),
('Hamline Condos',                                      (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 10),
('The Groveland',                                       (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 11),
('Lake Point',                                          (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 12),
('Blaisdell',                                           (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 13),
('Village on the Park Condos',                          (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 14),
('Heatherton of Edina',                                 (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 15),
('Seahorse',                                            (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 16),
('Ambassador',                                          (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 17),
('Spencer Bernard',                                     (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-properties'), 'empty', 18);

-- ── PROPERTIES & CONTACTS — HOA General Training ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('HOA protocols — keys, access & carts',                (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 1),
('Who owns what — units vs building',                   (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 2),
('Entering a unit — rights & permission',               (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 3),
('What walls can we cut & whose permission',            (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 4),
('Key return procedure',                                (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 5),
('Water shutdowns — scheduling per building',           (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 6),
('Authority on a job — who gives approval',             (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 7),
('HOA invoice process — who pays for what',             (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 8),
('HOA bylaws — common vs unit pipes',                   (select id from categories where slug='properties-contacts'), (select id from subcategories where slug='hoa-general'), 'empty', 9);

-- ── PLUMBING TRAINING — Drain & Waste ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Drain cleaning — tools & techniques',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 1),
('Jetting — different sizes, safety & annual maintenance',(select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 2),
('HOA drain maintenance — annual jetting program',      (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 3),
('Kitchen drains — grease, flex shaft & building process',(select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 4),
('Drain camera — proper use & locators',                (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 5),
('Smoke machine — sewer gas testing',                   (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 6),
('Pipelining',                                          (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 7),
('Sump pumps vs sewage injectors',                      (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 8),
('Roof drains — types & complications',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 9),
('Flammable waste — what & where',                      (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 10),
('Cast iron cutting — Diablo blade vs snapper',         (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='drain-waste'), 'empty', 11);

-- ── PLUMBING TRAINING — Water & Fixtures ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Water heaters — multiple types & install process',    (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 1),
('Toilets — preferred method & parts',                  (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 2),
('Floor set rear outlet toilets',                       (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 3),
('Pressure tank type toilets',                          (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 4),
('Shower valves — types & preferred brand',             (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 5),
('Tiled shower — waterproofing & code',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 6),
('Shower drains — cup style, fire collar & install',    (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 7),
('Bathtub waste & overflow — full replacement',         (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 8),
('Kitchen sink strainers — cup style preferred',        (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 9),
('Fixing fixtures — what we fix & don''t',              (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 10),
('Spigots — freeze proof & winterising',                (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 11),
('Low water pressure — causes & fixes',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 12),
('Hot water circulation — methods & devices',           (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='water-fixtures'), 'empty', 13);

-- ── PLUMBING TRAINING — Pipes & Materials ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Types of copper — K, L, M, N',                       (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 1),
('Types of PEX — crimp vs expansion',                   (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 2),
('Mega press — when & where to use',                    (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 3),
('Cast iron vs PVC — when to use each',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 4),
('CPVC piping — glue cure times & risk management',     (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 5),
('Main water valves — gate to ball valve',              (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 6),
('Stop valves & valve replacement — Dahl preferred',    (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 7),
('Threaded ball valves — when & why',                   (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 8),
('Leaks — types, materials & permanent fixes',          (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 9),
('Frozen pipes — causes, fixes & what breaks',          (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 10),
('Thermal expansion — what it affects',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 11),
('Insulation — what we insulate & how',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 12),
('Condensation — prevention & our role',                (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 13),
('Condensate drain piping',                             (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 14),
('Water filtration systems',                            (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='pipes-materials'), 'empty', 15);

-- ── PLUMBING TRAINING — Specialist Skills ──
insert into videos (title, category_id, subcategory_id, status, sort_order) values
('Backflow devices — test, record & safety',            (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 1),
('Heating systems — zone valves, Honeywell & Danfoss',  (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 2),
('Thaw machine — operation & safety',                   (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 3),
('Gas piping — fixtures, pressures & vents',            (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 4),
('Kitchen remodels — waste, vent & cabinet coordination',(select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 5),
('Core drilling — tools & concrete types',              (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 6),
('Cutting & pouring concrete',                          (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 7),
('Anchors & mounting — preferred methods',              (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 8),
('Roof jacks — who waterproofs & when',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 9),
('Electrical — what we do vs electrician',              (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 10),
('Thermal imaging device — how to use',                 (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 11),
('Trusting your instincts on leaks',                    (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 12),
('Winterising — air compressor, antifreeze & procedure',(select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 13),
('Remodels — process & preferred products',             (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 14),
('Worker responsibility — tools, equipment & problem solving', (select id from categories where slug='plumbing-training'), (select id from subcategories where slug='specialist-skills'), 'empty', 15);
