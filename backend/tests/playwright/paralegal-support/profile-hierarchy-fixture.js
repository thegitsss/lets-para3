// Synthetic records only. Organization text uses the existing description field.
const populated = {
 firstName:'Morgan',lastName:'Ellis',email:'morgan.synthetic@example.com',state:'NY',location:'NY',yearsExperience:12,
 bio:'I help legal teams turn complex case records into clear, organized work. My experience includes commercial litigation, discovery planning and trial preparation across state and federal matters.\n\nI enjoy building practical systems for document review, coordinating deadlines and keeping attorneys informed as a matter develops.',
 practiceAreas:['Litigation','Employment Law','Intellectual Property','Corporate Law'],
 skills:['Discovery','Legal research','Document review','Relativity','Microsoft Excel'],
 bestFor:['Discovery','Trial preparation','Document-intensive matters','Deadline coordination'],
 stateExperience:['NY','NJ','CA','MA'],
 experience:[{title:'Senior litigation paralegal',years:'2020–present',description:'Example Legal Group · New York\nCoordinate discovery, maintain complex case records and prepare trial materials for commercial litigation teams.'},{title:'Paralegal',years:'2014–2020',description:'Sample Community Legal Center\nSupported employment matters, client intake and court filings.'}],
 education:[{school:'Example State University',degree:'B.A.',fieldOfStudy:'Legal Studies',startMonth:'September',startYear:'2010',endMonth:'May',endYear:'2014',grade:'Honors',activities:'Legal aid clinic and student research program'},{school:'Sample Continuing Education Institute',degree:'Certificate',fieldOfStudy:'eDiscovery',startYear:'2018',endYear:'2019'}],
 languages:[{name:'English',proficiency:'Native'},{name:'Spanish',proficiency:'Professional'},{name:'French',proficiency:'Conversational'}],
 linkedInURL:'https://www.linkedin.com/in/morgan-synthetic-example',
};
const incomplete={firstName:'Morgan',lastName:'Ellis',bio:'',practiceAreas:[],skills:[],bestFor:[],stateExperience:[],experience:[],education:[],languages:[],yearsExperience:0,linkedInURL:'',resumeURL:'',certificateURL:'',writingSampleURL:'',profileImage:'',profilePhotoStatus:'unsubmitted'};
module.exports={populated,incomplete};
