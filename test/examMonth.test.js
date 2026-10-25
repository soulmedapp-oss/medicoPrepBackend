const test = require('node:test');
const assert = require('node:assert/strict');
const Question = require('../src/models/Question');
test('exam month survives model serialization and can be cleared without affecting year', () => {
 const q = new Question({ question_text:'Example?', exam_year:2022, exam_month:6 });
 assert.equal(q.toObject().exam_month,6);q.exam_month=null;
 assert.equal(q.toObject().exam_month,null);assert.equal(q.exam_year,2022);
 assert.equal(new Question({question_text:'Old question'}).exam_month,null);
});
test('question schema rejects invalid exam months', () => {
 for(const exam_month of [0,13,1.5,'invalid']) {
  const q=new Question({question_text:'Example?',exam_month});
  assert.ok(q.validateSync()?.errors.exam_month, String(exam_month));
 }
 for(const exam_month of [1,6,12,null]) assert.equal(new Question({question_text:'Example?',exam_month}).validateSync()?.errors.exam_month,undefined);
});
