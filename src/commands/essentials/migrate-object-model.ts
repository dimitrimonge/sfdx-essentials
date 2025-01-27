import { Command, flags } from '@oclif/command';
import * as glob from 'glob';
import * as fs from 'fs';
import * as fsExtra from 'fs-extra';
import * as rimraf from 'rimraf';
import * as xml2js from 'xml2js';
import * as cliProgress from 'cli-progress';
import EssentialsUtils = require('../../common/essentials-utils');

export default class ExecuteFilter extends Command {
  public static description = '';

  public static examples = [];

  public static flags: any = {
    // flag with a value (-n, --name=VALUE)
    configFile: flags.string({ char: 'c', description: 'JSON config file' }),
    inputFolder: flags.string({ char: 'i', description: 'Input folder (default: "." )' }),
    fetchExpressionList: flags.string({ char: 'f', description: 'Fetch expression list. Let default if you dont know. ex: /aura/**/*.js,./aura/**/*.cmp,./classes/*.cls,./objects/*/fields/*.xml,./objects/*/recordTypes/*.xml,./triggers/*.trigger,./permissionsets/*.xml,./profiles/*.xml,./staticresources/*.json' }),
    deleteFiles: flags.string({ char: 'd', description: 'Delete files with deprecated references', default: 'true' }),
    copySfdxProjectFolder: flags.string({ char: 's', description: 'Copy sfdx project files after process', default: 'true' }),
    verbose: flags.boolean({ char: 'v', description: 'Verbose', default: false })
  };

  public static args = [];

  // Input params properties
  public configFile: string;
  public inputFolder: string;
  public fetchExpressionList: string[] = [
    './aura/**/*.js',
    './aura/**/*.cmp',
    './classes/*.cls',
    './objects/*/fields/*.xml',
    './objects/*/recordTypes/*.xml',
    './triggers/*.trigger',
    './permissionsets/*.xml',
    './profiles/*.xml',
    './staticresources/*.json'
  ];
  public deleteFiles: boolean = true;
  public copySfdxProjectFolder: boolean = true;
  public verbose: boolean = false;

  // Internal props
  public configData: any;
  public multibar: any;
  public multibars: any = {};

  // Runtime methods
  public async run() {

    const elapseStart = Date.now();
    // tslint:disable-next-line:no-shadowed-variable
    const { args, flags } = this.parse(ExecuteFilter);

    this.inputFolder = flags.inputFolder || '.';
    this.configFile = flags.configFile;
    this.deleteFiles = (flags.deleteFiles === 'true');
    this.copySfdxProjectFolder = (flags.copySfdxProjectFolder === 'true');
    this.verbose = flags.verbose;

    if (flags.fetchExpressionList) {
      this.fetchExpressionList = flags.fetchExpressionList.split(',');
    } else if (flags.fetchExpressionList === '') {
      this.fetchExpressionList = [];
    }

    // Read config file and store it in class variable
    const jsonDataModelToMigrate = fs.readFileSync(this.configFile);
    this.configData = JSON.parse(jsonDataModelToMigrate.toString());

    // Build progress bars
    // @ts-ignore
    this.multibar = new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      fps: 500,
      format: '{name} [{bar}] {percentage}% | {value}/{total} | {file} '
    }, cliProgress.Presets.shades_grey);
    this.multibars.total = this.multibar.create(this.fetchExpressionList.length, 0, { name: 'Total'.padEnd(30, ' '), file: 'N/A' });
    // Expression list progress bars
    this.fetchExpressionList.forEach((fetchExpression: string) => {
      const customFileNameList = glob.sync(this.inputFolder + '/' + fetchExpression);
      this.multibars[fetchExpression] = this.multibar.create(customFileNameList.length, 0, { name: fetchExpression.padEnd(30, ' '), file: 'N/A' });
    });
    // Delete files progress bar
    if (this.deleteFiles && this.configData.objectToDelete) {
      this.multibars.deleteFiles = this.multibar.create(1, 0, { name: 'Delete files & folders'.padEnd(30, ' '), file: 'N/A' });
      this.multibars.total.setTotal(this.multibars.total.getTotal() + 1);
    }
    // Copy sfdx folder progress bar
    if (this.copySfdxProjectFolder && this.configData.sfdxProjectFolder) {
      this.multibars.sfdxProjectFolder = this.multibar.create(1, 0, { name: 'Copy SFDX Project'.padEnd(30, ' '), file: 'N/A' });
      this.multibars.total.setTotal(this.multibars.total.getTotal() + 1);
    }

    // Iterate on each expression to browse files
    for (const fetchExpression of this.fetchExpressionList) {
      const fetchExprStartTime = Date.now();
      // Get all files matching expression
      const customFileNameList = glob.sync(this.inputFolder + '/' + fetchExpression);

      // Process file
      for (const customFileName of customFileNameList) {
        this.multibars[fetchExpression].update(null, { file: customFileName });
        this.multibar.update();
        if (fetchExpression.includes('objects') && fetchExpression.includes('fields')) {
          //  dataModel file to read
          const objectsToMigrate = this.configData.objects;
          // create a new lookup fields which match with the new object
          await this.processFileXmlFields(customFileName, objectsToMigrate);
        } else {
          const replaceList = this.getObjectAndFieldToReplace(fetchExpression);

          // Replace in .cmp, .app & .evt files (send function as parameter)
          await this.processFileApexJsCmp(customFileName, replaceList);
        }
        this.multibars[fetchExpression].increment();
        this.multibar.update();
      }
      // progress bar update
      // @ts-ignore
      this.multibars[fetchExpression].update(null, { file: 'Completed in ' + EssentialsUtils.formatSecs(Math.round((Date.now() - fetchExprStartTime) / 1000)) });
      this.multibars.total.increment();
      this.multibar.update();
    }

    // Delete Old data model content
    if (this.deleteFiles) {
      await this.deleteOldDataModelReferency();
    }

    // If defined, copy manually updated sfdx project ( including new object model )
    if (this.copySfdxProjectFolder) {
      await this.copySfdxProjectManualItems();
    }
    // @ts-ignore
    this.multibars.total.update(null, { file: 'Completed in ' + EssentialsUtils.formatSecs(Math.round((Date.now() - elapseStart) / 1000)) });
    this.multibars.total.stop();
    this.multibar.update();
    this.multibar.stop();
  }

  // Process component file
  public async processFileApexJsCmp(customComponentFolder: any, replaceList: any) {
    // Find file
    let filePath = null;

    const filePathTest = customComponentFolder;
    if (filePath == null && fs.existsSync(filePathTest)) {
      filePath = filePathTest;
    }
    if (filePath == null) {
      return;
    }

    // Read file
    const fileContent = fs.readFileSync(filePath);
    if (fileContent == null) {
      console.log('Warning: empty file -> ' + filePath);
      return;
    }
    let arrayFileLines = fileContent.toString().split('\n');
    const initialArrayFileLines = arrayFileLines;

    // Process file lines one by one
    //  dataModel file to read
    const regexEpression: any = [];
    if (this.configData && this.configData.globalConfig) {
      regexEpression.Before = this.configData.globalConfig.regexEpressionBeforeElement;
      regexEpression.After = this.configData.globalConfig.regexEpressionAfterElement;
    }
    if (replaceList) {

      const extensionElement = filePath.split('.')[filePath.split('.').length - 1];
      let className = filePath.split('/')[filePath.split('/').length - 1];
      className = className.substring(0, className.indexOf('.' + extensionElement));

      for (const rep of replaceList) {
        const toReplace = rep[0];
        const replaceBy = rep[1];
        const caseSensitive = rep[2];

        let excludeList: any[];
        let includeList: any[];
        let replace: boolean = true;

        // Create the exclude and include element list for specific object or field
        if (rep[3] && rep[3].exclude && rep[3].exclude[extensionElement] !== undefined) {
          excludeList = rep[3].exclude[extensionElement];
        } else if (rep[3] && rep[3].include && rep[3].include[extensionElement] !== undefined) {
          includeList = rep[3].include[extensionElement];
        }
        if (excludeList) {
          replace = true;
          for (let excludeItem of excludeList) {
            if (excludeItem === className) {
              replace = false;
              break;
            } else if (excludeItem.endsWith('%') && className.toUpperCase().startsWith(excludeItem.substring(0, excludeItem.indexOf('%')).toUpperCase())) {
              replace = false;
              if (rep[3].exceptionExclude) {

                const exceptionExluceList = rep[3].exceptionExclude;
                for (let exceptionExluce of exceptionExluceList) {
                  if (className === exceptionExluce) {
                    replace = true;
                  }
                }
              }
              break;
            }
          }
          if (replace) {
            arrayFileLines = await this.readAndReplace(arrayFileLines, caseSensitive, toReplace, replaceBy, rep[4], regexEpression);
          }
        } else if (includeList) {
          // if includelist exist but empty that means no element should be replace
          if (includeList.length !== 0) {
            for (const includeItem of includeList) {
              if (includeItem === className) {
                replace = true;
              } else if (includeItem.endsWith('%') && className.toUpperCase().startsWith(includeItem.substring(0, includeItem.indexOf('%')).toUpperCase())) {
                replace = true;
              } else {
                replace = false;
              }
              if (replace) {
                arrayFileLines = await this.readAndReplace(arrayFileLines, caseSensitive, toReplace, replaceBy, rep[4], regexEpression);
              }
            }
          }
        } else {
          arrayFileLines = await this.readAndReplace(arrayFileLines, caseSensitive, toReplace, replaceBy, rep[4], regexEpression);
        }
      }
    }
    // Write new version of the file if updated
    if (initialArrayFileLines !== arrayFileLines) {
      this.createOrUpdatefile(arrayFileLines, filePath);
    }
  }

  public async processFileXmlFields(xmlFile: any, replaceField: any) {
    const parser = new xml2js.Parser();
    const builder = new xml2js.Builder();

    // Create a new file to migrate the lookup field
    const data = fs.readFileSync(xmlFile);
    parser.parseString(data, async (err2, fileXmlContent) => {
      if (fileXmlContent) {
        for (const eltKey of Object.keys(fileXmlContent)) {
          for (let i = 0; i < replaceField.length; i++) {
            if (fileXmlContent[eltKey].referenceTo && fileXmlContent[eltKey].referenceTo[0] && fileXmlContent[eltKey].referenceTo[0] === replaceField[i].previousObject) {
              fileXmlContent[eltKey].referenceTo[0] = replaceField[i].newObject;
              fileXmlContent[eltKey].label[0] = replaceField[i].newLabel;
              fileXmlContent[eltKey].fullName[0] = replaceField[i].newObject;

              fileXmlContent[eltKey].relationshipName[0] = fileXmlContent[eltKey].relationshipName[0].replace('_', '');

              xmlFile = xmlFile.substring(0, xmlFile.indexOf('fields')) + 'fields/' + replaceField[i].newObject + '.field-meta.xml';
              try {
                const updatedObjectXml = builder.buildObject(fileXmlContent);
                fs.writeFileSync(xmlFile, updatedObjectXml);
              } catch (e) {
                // Commented : error must have been manually managed in sfdxProjectFiles
                /*  console.error(e.message);
                  console.error(xmlFile);
                  console.error(fileXmlContent); */
              }
              break;
            }
          }
        }
      }
    });
  }

  // add specific caracter around the field/object we need to replace
  public getObjectAndFieldToReplace(fetchExpression: string) {
    //  dataModel file to read
    const objectsToMigrate = this.configData.objects;

    const replaceList: any[] = [];

    // Default replacement list for object
    let aroundCharReplaceObjectList = [
      { name: 'simpleQuote', before: '\'', after: '\'', replacementPrefix: null, replacementSuffix: null },
      { name: 'tag', before: '<', after: '>' },
      { name: 'xmlFile', before: '>', after: '</' },
      { name: 'stringlist', before: '\'', after: '.' }, // ClassName.MEthodNmae('MyObject.Myfield');
      { name: 'space', before: ' ', after: ' ' },
      { name: 'spacePoint', before: ' ', after: '.' }, // Database.upsert( objectList, fieldobject.Fields.fieldName__c,false) ;
      { name: 'parenthesis', before: '\(', after: '\)' },
      { name: 'loop', before: '\(', after: '\ ' }, //  for (MyObject object : MyObjectList)
      { name: 'newObject', before: '\ ', after: '\(' },      // ex: MyObject myObj = new MyObject()
      { name: 'objectInParenthesis', before: '\ ', after: '\)' },      //  System.assert( object instanceof objectInstance__c);
      { name: 'object', before: '"', after: '.' }, // value="MyObject__c.Field__c"
      { name: 'DeclarationObject', before: '"', after: '"' }, //  <aura:attribute name="Fields__c" type="String" />
      { name: 'GetRecordtypeinjson', before: '"', after: '@' }, //  TO PUT IN THE JSONCONFIG FILE NOT HERE
      { name: 'fieldEndline', before: ' ', after: '$' } // Select Id FROM MyObject__c \n WHERE Field == 'tes''
    ];

    // Complete aroundCharReplaceList with json config (replae by name value , or append if name not found)
    if (this.configData.globalConfig && this.configData.globalConfig.aroundCharReplaceObjectListOverride) {
      aroundCharReplaceObjectList = this.aroundCharReplaceList(aroundCharReplaceObjectList, this.configData.globalConfig.aroundCharReplaceObjectListOverride, fetchExpression);
    }

    // Default replacement list for object
    let aroundCharReplacefieldList = [
      { name: 'simpleQuote', before: '\'', after: '\'', replacementPrefix: null, replacementSuffix: null },
      { name: 'simpleQuoteFields', before: '\'', after: '.', replacementPrefix: null, replacementSuffix: null },
      { name: 'point', before: '.', after: '.' },
      { name: 'pointSpace', before: '.', after: ' ' },
      { name: 'xmlFile', before: '>', after: '</' },
      { name: 'xmlFile', before: '.', after: '</' },
      { name: 'pointQuote', before: '.', after: '\'' }, // ClassName.MEthodNmae('MyObject.Myfield');
      { name: 'spacePoint', before: ' ', after: '.' }, // Database.upsert( objectList, fieldobject.Fields.fieldName__c,false) ;
      { name: 'pointEndLine', before: '.', after: ';' }, // Select id FROM MyObject__c WHERE ObjectFields__r.objectField__c
      { name: 'objectArgument', before: '(', after: '=' }, //   Object myObject = new Object(field1__c=value1, field2__c = value2);
      { name: 'fieldParenthesis', before: '(', after: ')' }, //   toLabel(field1__c)
      { name: 'endOfstring', before: ' ', after: '\'' }, //   database.query('Select id, Fields1__c, Fields__c FROM MyObject__c WHERE ObjectFields__r.objectField__c')
      { name: 'selectfields', before: ' ', after: ',' }, //   Select id, Fields1__c, Fields__c FROM MyObject__c WHERE ObjectFields__r.objectField__c
      { name: 'pointArgument', before: '.', after: ',' }, //  className.method(myObject.field1__r,myObject.field1__C);
      { name: 'pointEndParenthesis', before: '.', after: ')' },    // field in parenthesis className.method(myObject.field1__r,myObject.field1__C);
      { name: 'SOQLRequest', before: ',', after: '.' }, // lookup fields SELECT Id,Name,lookupField__r.fields
      { name: 'newObjectInitialize', before: ' ', after: '=' }, // l new myObject(field1__c=acc.Id, Field2__c='Owner')
      { name: 'firstSOQLRequest', before: 'SELECT ', after: ' ' },    // in request soql SELECT field FROM
      { name: 'firstSOQLRequestofList', before: 'SELECT ', after: ',' }, // in request soql SELECT field, field2 FROM
      { name: 'SOQLRequestofList', before: ' ', after: ',' }, // in request soql SELECT field, field2 FROM
      { name: 'lastSOQLRequestofList', before: ' ', after: ' FROM' },    // in request soql SELECT field, field2 FROM
      { name: 'lastSOQLRequestofList', before: ',', after: ' FROM' },    // in request soql SELECT field,field2 FROM
      { name: 'equality', before: '.', after: '=' },    // field== 'value'
      { name: 'list', before: '.', after: '}' },    // new List<String>{MyOject.Field__c});
      { name: 'inequality', before: '.', after: '!' },    // field!= 'value'
      { name: 'Concatenation', before: '.', after: '+' },    // String test = SFObject.Field1__c+';'+SFObject.Field2__c;
      { name: 'comaComa', before: ',', after: ',' }, // in select example Select field,field,field FROM Object
      { name: 'pointCalculator', before: '.', after: '*' }, // operation on field Myobject.Field__c*2
      { name: 'componentfield', before: '.', after: '"' }, // value="MyObject__c.Field__c"
      { name: 'DeclarationField', before: '"', after: '"' }, //  <aura:attribute name="Fields__c" type="String" />
      { name: 'fieldEndline', before: '.', after: '$' } // if  MyObject__c.Field == MyObject__c.Field2 \n || etc...
    ];

    // Complete aroundCharReplaceList with json config (replae by name value , or append if name not found)
    if (this.configData.globalConfig && this.configData.globalConfig.aroundCharReplaceFieldListOverride) {
      aroundCharReplacefieldList = this.aroundCharReplaceList(aroundCharReplacefieldList,
        this.configData.globalConfig.aroundCharReplaceFieldListOverride,
        fetchExpression);
    }

    objectsToMigrate.forEach((object: any) => {

      aroundCharReplaceObjectList.forEach((aroundChars) => {
        let oldString: string;
        if (!aroundChars.after.includes('$')) {
          oldString = '\\' + aroundChars.before + object.previousObject + '\\' + aroundChars.after;
        } else {
          oldString = '\\' + aroundChars.before + object.previousObject + aroundChars.after;
        }
        let newString = aroundChars.before + object.newObject;

        if (aroundChars.after !== '$') {
          newString += aroundChars.after;
        }
        if (aroundChars.replacementPrefix) {
          newString = aroundChars.replacementPrefix + newString;
        }
        if (aroundChars.replacementSuffix) {
          newString += aroundChars.replacementSuffix;
        }
        let replaceObject: any;
        replaceObject = [oldString, newString, object.caseSensitive, { exclude: object.exclude, include: object.include }, { oldObject: object.previousObject, newObject: object.newObject }];

        // Add exclude exception if need (exemple : exclude = className% exception = classeNameException)
        if (object.exclude && object.exclude.exceptionList) {
          replaceObject[3].exceptionExclude = object.exclude.exceptionList;
        }
        if (object.include && object.include.exceptionList) {
          replaceObject[3].exceptionInclude = object.include.exceptionList;
        }

        replaceList.push(replaceObject);
      });

      if (object.fieldsMapping) {
        object.fieldsMapping.forEach((fieldToChange) => {

          aroundCharReplacefieldList.forEach((aroundChars) => {
            let oldString;
            if (!aroundChars.after.includes('$')) {
              oldString = '\\' + aroundChars.before + fieldToChange.previousField + '\\' + aroundChars.after;
            } else {
              oldString = '\\' + aroundChars.before + fieldToChange.previousField + aroundChars.after;
            }
            let newString = aroundChars.before + fieldToChange.newField;

            if (aroundChars.after !== '$') {
              newString += aroundChars.after;
            }
            if (aroundChars.replacementPrefix) {
              newString = aroundChars.replacementPrefix + newString;
            }
            if (aroundChars.replacementSuffix) {
              newString += aroundChars.replacementSuffix;
            }

            let replacefield: any;
            replacefield = [oldString, newString, fieldToChange.caseSensitive, { exclude: fieldToChange.exclude, include: fieldToChange.include }];

            // Add include exception if need (exemple : include = className% exception = classeNameException)
            if (fieldToChange.exclude && fieldToChange.exclude.exceptionList) {
              replacefield[3].exceptionExclude = fieldToChange.exclude.exceptionList;
            }
            if (fieldToChange.include && fieldToChange.include.exceptionList) {
              replacefield[3].exceptionInclude = fieldToChange.include.exceptionList;
            }
            replaceList.push(replacefield);
          });
        });
      }
    });
    return replaceList;
  }

  // add element to the list
  public aroundCharReplaceList(aroundCharReplaceObjectList: any, aroundCharReplaceListOverride: any, fetchExpression: string) {
    aroundCharReplaceListOverride.forEach((aroundCharsOverride: any) => {
      let replaced: boolean = false;
      aroundCharReplaceObjectList.forEach((aroundChars: any, i: number) => {
        if (aroundChars.name === aroundCharsOverride.name) {
          replaced = true;
          if (!aroundCharsOverride.affecteditems || (aroundCharsOverride.affecteditems && fetchExpression.endsWith(aroundCharsOverride.affecteditems))) {
            aroundCharReplaceObjectList[i] = aroundCharsOverride;
          }
        }
      });
      if (!replaced) {
        aroundCharReplaceObjectList.push(aroundCharsOverride);
      }
    });
    return aroundCharReplaceObjectList;
  }

  public async readAndReplace(arrayFileLines: any, caseSensitive: boolean, toReplace: string, replaceBy: string, replaceObject: any, regexEpression: any) {
    // console.log('processing ' + filePath + ' ' + toReplace + ' ' + replaceBy)
    const toReplaceWithRegex: string = toReplace;

    const arrayFileLinesNew: string[] = [];

    arrayFileLines.forEach((line: string) => {
      let regExGlobalRules: string = 'g';
      if (!line.trim().startsWith('//')) { // Do not convert commented lines
        if (!caseSensitive) {
          regExGlobalRules += 'i';
        }
        line = line.replace(new RegExp((regexEpression.Before != null ? regexEpression.Before : '') + toReplaceWithRegex + (regexEpression.After != null ? regexEpression.After : ''), regExGlobalRules), replaceBy);
      }
      arrayFileLinesNew.push(line);
    });
    return arrayFileLinesNew;
  }

  public async createOrUpdatefile(arrayFileLines: any, filePath: any) {
    const updatedFileContent: string = arrayFileLines.join('\n');
    fs.writeFileSync(filePath, updatedFileContent);
    // + ' with content :\n' + updatedFileContent)
    return arrayFileLines;
  }

  // Delete referencies to old data model
  public async deleteOldDataModelReferency() {
    const objectToDelete = this.configData.objectToDelete;

    if (objectToDelete) {
      const elapseStart = Date.now();

      const customFileNameList = glob.sync('./*/*');
      this.multibars.deleteFiles.setTotal(customFileNameList.length);
      // @ts-ignore
      const interval = EssentialsUtils.multibarStartProgress(this.multibars, 'deleteFiles', this.multibar, 'Deleting files');
      await this.deleteFileOrFolder(customFileNameList, objectToDelete, true);
      // @ts-ignore
      EssentialsUtils.multibarStopProgress(interval);
      // @ts-ignore
      this.multibars.deleteFiles.update(null, { file: 'Completed in ' + EssentialsUtils.formatSecs(Math.round((Date.now() - elapseStart) / 1000)) });
      this.multibars.total.increment();
    }

  }

  public async deleteFileOrFolder(customFileNameList: any, objectToDelete: any, increment = false) {
    for (const file of customFileNameList) {
      if (increment) {
        this.multibars.deleteFiles.increment();
        this.multibar.update();
      }
      if (file.includes(objectToDelete.prefixe)) {

        fsExtra.remove(file, (err: any) => {
          if (err) { throw err; }
          // if no error, file has been deleted successfully
          // console.log('deleted file :' + file);
        });
        rimraf(file, (err: any) => {
          if (err) { throw err; }
          // if no error, file has been deleted successfully
          // console.log('deleted folder :' + file);
        });

      } else if (!file.match(/\.[0-9a-z]+$/i)) {
        const customFileNameList2 = glob.sync(file + '/*');
        await this.deleteFileOrFolder(customFileNameList2, objectToDelete);
      } else if (file.match(/\.field-meta\.xml+$/i)) {
        // Create a new file to migrate the lookup field
        const data = fs.readFileSync(file);
        const parser = new xml2js.Parser();
        parser.parseString(data, (err2, fileXmlContent) => {
          if (fileXmlContent) {
            for (let i = 0; i < Object.keys(fileXmlContent).length; i++) {
              const eltKey = Object.keys(fileXmlContent)[i];
              if (fileXmlContent[eltKey].referenceTo && fileXmlContent[eltKey].referenceTo[0] && fileXmlContent[eltKey].referenceTo[0].includes(objectToDelete.prefixe)) {
                if (fs.existsSync(file)) {
                  fsExtra.remove(file, (err: any) => {
                    if (err) { throw err; }
                    // if no error, file has been deleted successfully
                    // console.log('deleted file :' + file);
                  });
                  break;
                }
              }

            }
          }
        });

      } else if (file.match(/\.layout-meta\.xml+$/i)) {
        const data = fs.readFileSync(file);
        const parser = new xml2js.Parser();

        parser.parseString(data, (err2, fileXmlContent) => {
          if (fileXmlContent['Layout']['layoutSections']) {
            for (let i = 0; i < fileXmlContent['Layout']['layoutSections'].length; i++) {
              const layoutSections = fileXmlContent['Layout']['layoutSections'][i];
              if (layoutSections['layoutColumns']) {
                for (let j = 0; j < layoutSections['layoutColumns'].length; j++) {
                  if (layoutSections['layoutColumns'][j]['layoutItems']) {
                    for (let k = 0; k < layoutSections['layoutColumns'][j]['layoutItems'].length; k++) {
                      if (layoutSections['layoutColumns'][j]['layoutItems'][k]['field'] && (layoutSections['layoutColumns'][j]['layoutItems'][k]['field'][0].includes(objectToDelete.prefixe) || layoutSections['layoutColumns'][j]['layoutItems'][k]['field'][0].includes('FinancialAccount__c'))) {
                        if (fs.existsSync(file)) {
                          fsExtra.remove(file, (err: any) => {
                            if (err) { throw err; }
                            // if no error, file has been deleted successfully
                            // console.log('deleted file :' + file);
                          });
                        }
                      }
                    }

                  }
                }

              }
            }
          }
          if (fileXmlContent['Layout']['platformActionList']) {
            for (let i = 0; i < fileXmlContent['Layout']['platformActionList'].length; i++) {
              const platformActionList = fileXmlContent['Layout']['platformActionList'][i];
              if (platformActionList['platformActionListItems']) {
                for (let k = 0; k < platformActionList['platformActionListItems'].length; k++) {
                  if (platformActionList['platformActionListItems'][k]['actionName'] && platformActionList['platformActionListItems'][k]['actionName'][0].includes(objectToDelete.prefixe)) {
                    if (fs.existsSync(file)) {
                      fsExtra.remove(file, (err: any) => {
                        if (err) { throw err; }
                        // if no error, file has been deleted successfully
                        // console.log('deleted file :' + file);
                      });
                    }
                  }
                }
              }
            }
          }
        });
      }
    }
  }

  // Copy Sfdx project items
  public async copySfdxProjectManualItems() {
    const sfdxProjectFolder = this.configData.sfdxProjectFolder;
    if (sfdxProjectFolder) {
      const elapseStart = Date.now();
      // @ts-ignore
      const interval = EssentialsUtils.multibarStartProgress(this.multibars, 'sfdxProjectFolder', this.multibar, 'Copying files');
      await fsExtra.copy(this.configData.sfdxProjectFolder, this.inputFolder);
      // @ts-ignore
      EssentialsUtils.multibarStopProgress(interval);
      this.multibars.sfdxProjectFolder.increment();
      // @ts-ignore
      this.multibars.sfdxProjectFolder.update(null, { file: 'Completed in ' + EssentialsUtils.formatSecs(Math.round((Date.now() - elapseStart) / 1000)) });
      this.multibars.total.increment();
      this.multibar.update();
    }
  }

}
