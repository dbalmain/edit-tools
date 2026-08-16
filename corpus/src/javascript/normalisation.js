// Input written the way a person writes it and prettier does not: wrong spacing
// around operators and delimiters, padding inside brackets, wrong indentation,
// runs of spaces before a trailing comment.
function weird( a , b ){
    const result=a+b* 2;
    return result;
}

const emptyCall = f( );
const emptyArray = [ ];
const emptyObject = { };

const padded=[ 1,2,3 ];
const tight={ x:1,y:2 };
const spaced = { a : 1 , b : 2 };

const redundant = ((1 + 2));

if ( x ){ y=1 }else{ y=2 }

const trailingSpaces = 1       // lots of spaces before this comment

function indented() {
		const n = 0;
		if (n === 0) {
				n = 1;
		}
		return n;
}
